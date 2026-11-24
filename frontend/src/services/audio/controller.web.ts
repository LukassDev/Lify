import { waitForPlayback } from './playbackDelay';
import { catalog } from '@/services/catalog';
import { getDb, historyRepo, settingsRepo } from '@/database';
import type { RepeatMode, Track } from '@/types';
import {
  DownloadedTrackUnavailableError,
  resolveDownloadedTrack,
} from '@/features/downloads';
import {
  appendRecommended,
  currentOf,
  moveQueueItem,
  emptyQueue,
  enqueue as qEnqueue,
  nextIndex,
  playNext as qPlayNext,
  prevIndex,
  removeAt,
  setQueue,
  shuffleRest,
  shuffleAll,
  restoreShuffleOrder,
  shouldFetchRecommendations,
  type QueueState,
} from './queue';
import { usePlayerStore } from './store';
import { t as tr } from '@/i18n';
import { getWebFileUrl } from '@/storage/webFiles';
import { PlaybackHistoryTracker } from './playbackHistory';
import { prefetchArtwork } from '@/services/artwork';

const store = () => usePlayerStore.getState();
let audioElement: HTMLAudioElement | null = null;
let detachAudioEvents: (() => void) | null = null;
let playbackAbort: AbortController | null = null;
let disposed = false;
let unsubscribePlayerStore: (() => void) | null = null;
const MAX_AUTOMATIC_RETRIES = 3;
const TRACK_END_TOLERANCE_SECONDS = 2;
interface WebPlaybackSession {
  token: number;
  audio: HTMLAudioElement;
  track: Track;
  streamed: boolean;
  position: number;
  duration: number;
}
let activePlayback: WebPlaybackSession | null = null;
let automaticRetry: { trackId: string; attempts: number; resumePosition: number } | null = null;
let handledFailureToken: number | null = null;
let queueEndToken: number | null = null;
let setupPromise: Promise<void> | null = null;
let loadToken = 0;
let sleepTimer: ReturnType<typeof setTimeout> | null = null;
let recommendationRequestTrackId: string | null = null;
const WEB_PLAYER_STORAGE_KEY = 'lify.webPlayer.v1';
let restoredPosition = 0;
let lastPositionPersistAt = 0;
let historyTracker: PlaybackHistoryTracker | null = null;
let playbackChannel: BroadcastChannel | null = null;
const playbackOwner = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

// Fast Refresh não pode deixar o elemento de áudio da versão anterior a tocar.
const runtimeHost = globalThis as typeof globalThis & {
  __lifyWebAudioRuntime?: { dispose: () => void };
};
runtimeHost.__lifyWebAudioRuntime?.dispose();
runtimeHost.__lifyWebAudioRuntime = { dispose: disposeWebPlayback };

if (typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
  try {
    playbackChannel = new BroadcastChannel('lify.webPlayback');
    playbackChannel.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (!data || typeof data !== 'object') return;
      const message = data as { type?: string; owner?: string };
      if (message.type === 'claim-playback' && message.owner !== playbackOwner) void pause();
    };
  } catch {
    playbackChannel = null;
  }
}

function claimPlayback(): void {
  playbackChannel?.postMessage({ type: 'claim-playback', owner: playbackOwner });
}

function releaseAudio(): void {
  playbackAbort?.abort();
  playbackAbort = null;
  detachAudioEvents?.();
  detachAudioEvents = null;
  const previous = audioElement;
  audioElement = null;
  if (previous) {
    previous.pause();
    previous.removeAttribute('src');
    previous.load();
  }
}

function disposeWebPlayback(): void {
  persistWebQueue();
  disposed = true;
  ++loadToken;
  if (sleepTimer) clearTimeout(sleepTimer);
  sleepTimer = null;
  unsubscribePlayerStore?.();
  playbackChannel?.close();
  playbackChannel = null;
  historyTracker?.setPlaying(false);
  releaseAudio();
  activePlayback = null;
  if (store().queue.items.length > 0) store().set({ status: 'paused' });
}

function isCurrentSession(session: WebPlaybackSession): boolean {
  return !disposed && activePlayback === session && session.token === loadToken
    && session.audio === audioElement && currentOf(store().queue)?.id === session.track.id;
}

function startHistoryTracking(track: Track, position = 0): void {
  historyTracker = new PlaybackHistoryTracker(track, (item) => {
    void recordHistory(item).catch((error: unknown) => {
      console.warn('[history] Could not record playback', error);
    });
  }, position);
}

function persistWebQueue(queue = store().queue): void {
  if (typeof window === 'undefined') return;
  try {
    if (queue.items.length === 0) {
      window.localStorage.removeItem(WEB_PLAYER_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(WEB_PLAYER_STORAGE_KEY, JSON.stringify({
      queue,
      position: activePlayback && activePlayback.track.id === currentOf(queue)?.id
        ? activePlayback.audio === audioElement ? activePlayback.audio.currentTime : activePlayback.position
        : restoredPosition,
    }));
  } catch {
    // O armazenamento pode estar indisponível em navegação privada.
  }
}

function isTrack(value: unknown): value is Track {
  if (!value || typeof value !== 'object') return false;
  const track = value as Partial<Track>;
  return typeof track.id === 'string'
    && (track.source === 'youtube' || track.source === 'local')
    && typeof track.sourceId === 'string'
    && typeof track.title === 'string'
    && typeof track.artist === 'string'
    && (typeof track.album === 'string' || track.album === null)
    && (typeof track.durationSec === 'number' || track.durationSec === null)
    && typeof track.artworkUrl === 'string';
}

function restoreWebQueue(): void {
  if (typeof window === 'undefined') return;
  try {
    const raw = window.localStorage.getItem(WEB_PLAYER_STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as { queue?: Partial<QueueState>; position?: number };
    const items = saved.queue?.items;
    const index = saved.queue?.index;
    if (!Array.isArray(items) || !items.every(isTrack)
      || !Number.isInteger(index) || index === undefined || index < 0 || index >= items.length) {
      window.localStorage.removeItem(WEB_PLAYER_STORAGE_KEY);
      return;
    }
    if (store().queue.items.length > 0) {
      if (currentOf(store().queue)?.id === items[index].id) {
        restoredPosition = Number.isFinite(saved.position) ? Math.max(0, saved.position ?? 0) : 0;
      }
      return;
    }
    const queue: QueueState = { items, index };
    const recStart = saved.queue?.recStart;
    if (Number.isInteger(recStart) && recStart !== undefined && recStart >= 0 && recStart < items.length) {
      queue.recStart = recStart;
    }
    restoredPosition = Number.isFinite(saved.position) ? Math.max(0, saved.position ?? 0) : 0;
    store().set({ queue, status: 'paused', error: null });
  } catch {
    window.localStorage.removeItem(WEB_PLAYER_STORAGE_KEY);
  }
}

unsubscribePlayerStore = usePlayerStore.subscribe((state, previous) => {
  if (state.queue !== previous.queue) persistWebQueue(state.queue);
});

export function getWebAudioElement(): HTMLAudioElement {
  return getAudio();
}

function getAudio(): HTMLAudioElement {
  if (!audioElement) {
    audioElement = new Audio();
    audioElement.preload = 'auto';
  }
  return audioElement;
}

function attachAudioEvents(session: WebPlaybackSession): void {
  const { audio } = session;
  const removers: (() => void)[] = [];
  const listen = (event: string, handler: () => void) => {
    const currentHandler = () => { if (isCurrentSession(session)) handler(); };
    audio.addEventListener(event, currentHandler);
    removers.push(() => audio.removeEventListener(event, currentHandler));
  };
  detachAudioEvents = () => { for (const remove of removers) remove(); };
  listen('pause', () => {
    historyTracker?.update(audio.currentTime, audio.duration);
    historyTracker?.setPlaying(false);
    if (!audio.ended && currentOf(store().queue)
      && store().status !== 'loading' && store().status !== 'error') {
      store().set({ status: 'paused' });
    }
  });
  listen('waiting', () => {
    historyTracker?.update(audio.currentTime, audio.duration);
    historyTracker?.setPlaying(false);
    if (store().status === 'playing') store().set({ status: 'buffering' });
  });
  listen('playing', () => {
    if (handledFailureToken === session.token) return;
    historyTracker?.seek(audio.currentTime);
    historyTracker?.setPlaying(true);
    store().set({ status: 'playing', error: null });
  });
  listen('seeking', () => historyTracker?.setPlaying(false));
  listen('seeked', () => {
    session.position = audio.currentTime;
    if (automaticRetry?.trackId === session.track.id) automaticRetry.resumePosition = audio.currentTime;
    historyTracker?.seek(audio.currentTime);
    historyTracker?.setPlaying(!audio.paused && !audio.ended
      && audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA);
  });
  listen('timeupdate', () => {
    const previousPosition = session.position;
    session.position = audio.currentTime;
    if (Number.isFinite(audio.duration) && audio.duration > 0) session.duration = Math.max(session.duration, audio.duration);
    const retry = automaticRetry;
    if (!audio.paused && !audio.seeking && !audio.error && store().status === 'playing'
      && retry?.trackId === session.track.id && audio.currentTime > previousPosition
      && audio.currentTime > retry.resumePosition) retry.attempts = 0;
    if (!audio.seeking) historyTracker?.update(audio.currentTime, audio.duration);
    const now = Date.now();
    if (now - lastPositionPersistAt < 5000) return;
    lastPositionPersistAt = now;
    persistWebQueue();
  });
  listen('ended', () => { void onAudioEnded(session); });
  listen('error', () => {
    historyTracker?.setPlaying(false);
    if (store().status !== 'loading') {
      void onTrackFailed(session, tr('player.streamInterrupted'));
    }
  });
}

export function setSleepTimer(minutes: number): void {
  if (!Number.isSafeInteger(minutes) || minutes <= 0 || !Number.isSafeInteger(Date.now() + minutes * 60_000)) {
    throw new RangeError('Sleep timer duration must be a positive, safe integer number of minutes.');
  }
  cancelSleepTimer();
  const endAt = Date.now() + minutes * 60_000;
  store().set({ sleepTimerEndsAt: endAt, sleepTimerPreset: minutes });
  const checkTimer = () => {
    if (store().sleepTimerEndsAt !== endAt) return;
    const remaining = endAt - Date.now();
    if (remaining > 0) {
      sleepTimer = setTimeout(checkTimer, Math.min(remaining, 2_147_000_000));
      return;
    }
    sleepTimer = null;
    void pause();
    store().set({ sleepTimerEndsAt: null, sleepTimerPreset: null, status: 'paused' });
  };
  checkTimer();
}

export function setSleepTimerAtTrackEnd(): void {
  if (sleepTimer) clearTimeout(sleepTimer);
  sleepTimer = null;
  store().set({ sleepTimerEndsAt: null, sleepTimerPreset: 'trackEnd' });
}

export function cancelSleepTimer(): void {
  if (sleepTimer) clearTimeout(sleepTimer);
  sleepTimer = null;
  store().set({ sleepTimerEndsAt: null, sleepTimerPreset: null });
}

export function setupAudio(): Promise<void> {
  if (!setupPromise) {
    setupPromise = (async () => {
      const settings = await settingsRepo.loadSettings(await getDb());
      if (disposed) return;
      store().set({ repeat: settings.repeatMode });
      getAudio();
    })().catch((error: unknown) => {
      setupPromise = null;
      throw error;
    });
  }
  return setupPromise;
}

export async function restoreNativeQueue(): Promise<void> {
  await setupAudio();
  if (disposed) return;
  restoreWebQueue();
  requestRecommendationsIfEnabled();
}

async function recordHistory(track: Track): Promise<void> {
  const db = await getDb();
  const settings = await settingsRepo.loadSettings(db);
  if (settings.historyEnabled) await historyRepo.recordPlay(db, track);
}

function prefetchNext(): void {
  const { queue, repeat } = store();
  prefetchArtwork(queue.items.slice(queue.index, queue.index + 4).map((track) => track.artworkUrl));
  const index = nextIndex(queue, repeat, false);
  const track = index === null ? null : queue.items[index];
  if (track && playbackAbort) {
    const signal = playbackAbort.signal;
    void waitForPlayback(signal, 1000).then(() => catalog.prefetch(track, signal)).catch(() => {});
  }
}

async function maybeFillQueue(): Promise<void> {
  const { queue, repeat } = store();
  const track = currentOf(queue);
  if ((repeat !== 'off' && repeat !== 'all') || queue.recStart !== undefined || !track || track.source !== 'youtube') return;
  if (recommendationRequestTrackId === track.id) return;
  recommendationRequestTrackId = track.id;
  try {
    const related = await catalog.getRelated(track);
    const current = store();
    if (disposed || (current.repeat !== 'off' && current.repeat !== 'all')
      || current.queue.recStart !== undefined
      || currentOf(current.queue)?.id !== track.id) return;
    const known = new Set(current.queue.items.map((item) => item.id));
    const fresh = related.filter((item) => !known.has(item.id));
    if (fresh.length) store().set({ queue: appendRecommended(current.queue, fresh) });
  } finally {
    if (recommendationRequestTrackId === track.id) recommendationRequestTrackId = null;
  }
}

function requestRecommendationsIfEnabled(): void {
  if (disposed) return;
  const { repeat } = store();
  if (repeat === 'off' || repeat === 'all') void maybeFillQueue().catch(() => {});
}

function waitForMetadata(audio: HTMLAudioElement, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      audio.removeEventListener('loadedmetadata', onReady);
      audio.removeEventListener('error', onError);
      signal.removeEventListener('abort', onAbort);
      clearTimeout(timeout);
    };
    const onReady = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error(tr('player.error'))); };
    const onAbort = () => { cleanup(); reject(new Error('Playback load cancelled')); };
    const timeout = setTimeout(onError, 45_000);
    audio.addEventListener('loadedmetadata', onReady, { once: true });
    audio.addEventListener('error', onError, { once: true });
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    else if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) onReady();
  });
}

async function onTrackFailed(session: WebPlaybackSession, message: string): Promise<void> {
  if (!isCurrentSession(session) || handledFailureToken === session.token) return;
  handledFailureToken = session.token;
  session.position = Math.max(session.position, session.audio.currentTime || 0);
  historyTracker?.setPlaying(false);
  store().set({ status: 'loading', error: null });
  session.audio.pause();
  const retry = automaticRetry;
  if (session.streamed && retry?.trackId === session.track.id && retry.attempts < MAX_AUTOMATIC_RETRIES) {
    retry.attempts += 1;
    await loadAndPlay(session.track, session.position, true);
    return;
  }
  if (isCurrentSession(session)) {
    releaseAudio();
    store().set({ status: 'error', error: message });
    persistWebQueue();
  }
}

async function loadAndPlay(track: Track, startAt = 0, isRetry = false): Promise<void> {
  if (disposed) return;
  if (!isRetry) claimPlayback();
  const token = ++loadToken;
  historyTracker?.setPlaying(false);
  if (!isRetry || historyTracker?.track.id !== track.id) historyTracker = null;
  // Para a fonte anterior antes de qualquer espera pela rede ou pela base de dados.
  releaseAudio();
  const audio = getAudio();
  const controller = new AbortController();
  playbackAbort = controller;
  const session: WebPlaybackSession = {
    token, audio, track, streamed: track.source === 'youtube',
    position: startAt, duration: track.durationSec ?? 0,
  };
  activePlayback = session;
  restoredPosition = 0;
  if (!isRetry || automaticRetry?.trackId !== track.id) {
    automaticRetry = { trackId: track.id, attempts: 0, resumePosition: startAt };
  } else {
    automaticRetry.resumePosition = startAt;
  }
  attachAudioEvents(session);
  store().set({ status: 'loading', error: null });
  try {
    await setupAudio();
    if (!isCurrentSession(session)) return;
    if (track.source === 'local' && track.sourceId.startsWith('local-unavailable:')) throw new Error(tr('drive.localUnavailable'));
    const downloaded = track.source === 'youtube' ? await resolveDownloadedTrack(track.id) : null;
    if (!isCurrentSession(session)) return;
    session.streamed = track.source === 'youtube' && !downloaded;
    let stream: { url: string; mimeType: string | null };
    if (downloaded) {
      stream = { url: downloaded.uri, mimeType: downloaded.mimeType };
    } else if (track.source === 'local' && track.sourceId.startsWith('web-audio:')) {
      const localUrl = await getWebFileUrl(track.sourceId);
      if (!localUrl) throw new Error(tr('downloads.fileMissing'));
      stream = { url: localUrl, mimeType: null };
    } else if (track.source === 'local') {
      stream = { url: track.sourceId, mimeType: null };
    } else {
      await waitForPlayback(controller.signal);
      if (!isCurrentSession(session)) return;
      stream = await catalog.getStream(track);
    }
    if (!isCurrentSession(session)) return;
    audio.src = stream.url;
    const metadata = waitForMetadata(audio, controller.signal);
    audio.load();
    await metadata;
    if (!isCurrentSession(session)) return;
    if (Number.isFinite(audio.duration) && audio.duration > 0) session.duration = Math.max(session.duration, audio.duration);
    if (startAt > 0) audio.currentTime = startAt;
    if (!historyTracker) startHistoryTracking(track, startAt);
    else historyTracker.seek(startAt);
    await audio.play();
    if (!isCurrentSession(session)) {
      audio.pause();
      return;
    }
    prefetchNext();
  } catch (error) {
    if (!isCurrentSession(session)) return;
    const message = error instanceof DownloadedTrackUnavailableError
      ? error.message
      : error instanceof Error ? error.message : tr('player.error');
    if (error instanceof DownloadedTrackUnavailableError || (error instanceof Error && error.name === 'NotAllowedError')) {
      releaseAudio();
      store().set({ status: 'error', error: message });
    } else {
      await onTrackFailed(session, message);
    }
  }
}

export async function playQueue(tracks: Track[], startIndex = 0, shuffle?: boolean): Promise<void> {
  if (disposed) return;
  if (tracks.length === 0) return stop();
  const enabled = shuffle ?? store().shuffle;
  let queue = setQueue(tracks, startIndex);
  if (shuffle === true) queue = shuffleAll(queue);
  else if (enabled) queue = shuffleRest(queue);
  store().set({ queue, shuffle: enabled });
  requestRecommendationsIfEnabled();
  const track = currentOf(queue);
  if (track) await loadAndPlay(track);
}

export const playTrack = (track: Track) => playQueue([track], 0);

export async function skipTo(index: number): Promise<void> {
  if (disposed) return;
  const { queue } = store();
  if (index < 0 || index >= queue.items.length) return;
  store().set({ queue: { ...queue, index } });
  await loadAndPlay(queue.items[index]);
}

export async function next(manual = true): Promise<void> {
  if (disposed) return;
  const { queue, repeat } = store();
  const index = nextIndex(queue, repeat, manual);
  if (index === null) {
    ++loadToken;
    historyTracker?.setPlaying(false);
    releaseAudio();
    activePlayback = null;
    automaticRetry = null;
    restoredPosition = 0;
    store().set({ status: 'paused' });
    persistWebQueue();
    return;
  }
  await skipTo(index);
}

export async function previous(): Promise<void> {
  const audio = getAudio();
  const { queue, repeat } = store();
  if (audio.currentTime > 3) {
    await seekTo(0);
    return;
  }
  const index = prevIndex(queue, repeat);
  if (index === null) {
    await seekTo(0);
    return;
  }
  await skipTo(index);
}

export async function togglePlay(): Promise<void> {
  if (disposed) return;
  const timerEndAt = store().sleepTimerEndsAt;
  if (timerEndAt !== null && Date.now() >= timerEndAt) {
    await pause();
    store().set({ sleepTimerEndsAt: null, sleepTimerPreset: null, status: 'paused' });
    return;
  }
  if (store().status === 'loading') return;
  if (!activePlayback || activePlayback.audio.paused || store().status === 'error' || store().status === 'idle') await play();
  else await pause();
}

export async function play(): Promise<void> {
  if (disposed || store().status === 'loading') return;
  claimPlayback();
  const track = currentOf(store().queue);
  if (!track) return;
  const session = activePlayback;
  if (!session || !isCurrentSession(session) || !session.audio.currentSrc || store().status === 'error') {
    const position = session?.track.id === track.id ? session.position : restoredPosition;
    await loadAndPlay(track, position);
    return;
  }
  try {
    await session.audio.play();
    if (!isCurrentSession(session)) session.audio.pause();
  } catch (error) {
    if (isCurrentSession(session)) store().set({ status: 'error', error: error instanceof Error ? error.message : tr('player.error') });
  }
}

export async function pause(): Promise<void> {
  if (disposed) return;
  historyTracker?.setPlaying(false);
  if (store().status === 'loading') {
    restoredPosition = activePlayback?.position ?? restoredPosition;
    ++loadToken;
    releaseAudio();
    activePlayback = null;
  } else {
    audioElement?.pause();
  }
  store().set({ status: 'paused' });
  persistWebQueue();
}

export const seekTo = async (seconds: number) => {
  const session = activePlayback;
  if (session && isCurrentSession(session) && Number.isFinite(seconds)
    && session.audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
    historyTracker?.setPlaying(false);
    const position = Math.max(0, seconds);
    session.position = position;
    if (automaticRetry) automaticRetry.resumePosition = position;
    session.audio.currentTime = position;
  }
};

export async function stop(): Promise<void> {
  if (disposed) return;
  ++loadToken;
  cancelSleepTimer();
  historyTracker?.setPlaying(false);
  releaseAudio();
  activePlayback = null;
  automaticRetry = null;
  restoredPosition = 0;
  historyTracker = null;
  store().set({ queue: emptyQueue, status: 'idle', error: null });
}

export function addToQueueNext(track: Track): void {
  const wasEmpty = store().queue.items.length === 0;
  store().set({ queue: qPlayNext(store().queue, track) });
  requestRecommendationsIfEnabled();
  if (wasEmpty) void loadAndPlay(track);
  else prefetchNext();
}

export function addToQueueEnd(tracks: Track[]): void {
  const wasEmpty = store().queue.items.length === 0;
  store().set({ queue: qEnqueue(store().queue, tracks) });
  requestRecommendationsIfEnabled();
  if (wasEmpty && tracks[0]) void loadAndPlay(tracks[0]);
  else prefetchNext();
}

export async function removeFromQueue(index: number): Promise<void> {
  const { queue } = store();
  const removingCurrent = index === queue.index;
  const nextQueue = removeAt(queue, index);
  store().set({ queue: nextQueue });
  if (removingCurrent) {
    const track = currentOf(nextQueue);
    if (track) await loadAndPlay(track);
    else await stop();
  } else {
    prefetchNext();
  }
}

export async function reorderQueue(from: number, to: number): Promise<void> {
  const queue = store().queue;
  const nextQueue = moveQueueItem(queue, from, to);
  if (nextQueue === queue) return;
  store().set({ queue: nextQueue });
  prefetchNext();
}

export function toggleShuffle(): void {
  const { queue, shuffle } = store();
  store().set({
    queue: shuffle ? restoreShuffleOrder(queue) : shuffleRest(queue),
    shuffle: !shuffle,
  });
  prefetchNext();
}

export async function setRepeat(mode: RepeatMode): Promise<void> {
  store().set({ repeat: mode });
  requestRecommendationsIfEnabled();
  prefetchNext();
  try {
    await settingsRepo.saveSetting(await getDb(), 'repeatMode', mode);
  } catch (error) {
    console.warn('[settings] Could not save repeat mode', error);
  }
}

async function onAudioEnded(session: WebPlaybackSession): Promise<void> {
  if (!isCurrentSession(session) || !session.audio.ended || session.audio.error
    || handledFailureToken === session.token || queueEndToken === session.token
    || store().status === 'loading' || store().status === 'error') return;
  queueEndToken = session.token;
  try {
    const { audio, track } = session;
    const position = Math.max(audio.currentTime, session.position);
    const duration = Math.max(session.duration, Number.isFinite(audio.duration) ? audio.duration : 0);
    session.position = position;
    historyTracker?.update(position, duration);
    historyTracker?.setPlaying(false);
    // Um stream cortado não é o fim da música, mesmo que o navegador emita ended.
    if (session.streamed && (!Number.isFinite(duration) || duration <= 0
      || position + TRACK_END_TOLERANCE_SECONDS < duration)) {
      await onTrackFailed(session, tr('player.streamInterrupted'));
      return;
    }
    if (store().sleepTimerPreset === 'trackEnd') {
      store().set({ sleepTimerEndsAt: null, sleepTimerPreset: null, status: 'paused' });
      return;
    }
    if (store().repeat === 'one') {
      await loadAndPlay(track);
      return;
    }
    if (shouldFetchRecommendations(store().queue, store().repeat)) {
      await maybeFillQueue().catch((error: unknown) => {
        console.warn('[catalog] Could not load recommended tracks', error);
      });
    }
    if (isCurrentSession(session) && audio.ended && !audio.error && handledFailureToken !== session.token) await next(false);
  } finally {
    if (queueEndToken === session.token) queueEndToken = null;
  }
}

export function attachPlayerEvents(): void {
  if (disposed) return;
  if (activePlayback && !detachAudioEvents) attachAudioEvents(activePlayback);
}
