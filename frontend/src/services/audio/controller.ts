import { PlaybackDelay, waitForPlayback } from './playbackDelay';
import TrackPlayer, {
  AppKilledPlaybackBehavior,
  Capability,
  Event,
  State,
  type Track as NativeTrack,
} from 'react-native-track-player';
import { catalog } from '@/services/catalog';
import { requestChoiceDialog } from '@/components/OverlayDialogHost';
import { getDb, historyRepo, settingsRepo } from '@/database';
import type { RepeatMode, Track } from '@/types';
import {
  DownloadedTrackUnavailableError, getTrackDownloadState, removeTrackDownload, resolveDownloadedTrack, startTrackDownload,
  type TrackDownloadTask,
} from '@/features/downloads';
import {
  currentOf, appendRecommended, moveQueueItem, nextIndex, playNext as qPlayNext, prevIndex,
  enqueue as qEnqueue, removeAt, setQueue, shuffleRest, shuffleAll, restoreShuffleOrder, emptyQueue, shouldFetchRecommendations,
} from './queue';
import { usePlayerStore, type PlayerStatus } from './store';
import { t as tr } from '@/i18n';
import { isDuplicateQueueEnd, queueEndSignature, type QueueEndSignature } from './queueEndGuard';
import { PlaybackHistoryTracker } from './playbackHistory';
import { prefetchArtwork } from '@/services/artwork';

const store = () => usePlayerStore.getState();
let setupDone: Promise<void> | null = null;
const MAX_AUTOMATIC_RETRIES = 3;
const TRACK_END_TOLERANCE_SECONDS = 2;
let automaticRetry: { trackId: string; attempts: number; resumePosition: number } | null = null;
let activePlayback: {
  token: number;
  trackId: string;
  streamed: boolean;
  position: number;
  duration: number;
} | null = null;
let handledFailureToken: number | null = null;
const playbackDelay = new PlaybackDelay();
let loadToken = 0; // invalida carregamentos antigos quando o usuário pula rápido
let queueEndToken: number | null = null;
let lastQueueEndEvent: QueueEndSignature | null = null;
let nativeOperations: Promise<void> = Promise.resolve();
let sleepTimer: ReturnType<typeof setTimeout> | null = null;
let recommendationRequestTrackId: string | null = null;
let historyTracker: PlaybackHistoryTracker | null = null;

function serializeNative<T>(operation: () => Promise<T>): Promise<T> {
  const result = nativeOperations.then(operation);
  nativeOperations = result.then(() => undefined, () => undefined);
  return result;
}

function scheduleSleepTimer(endAt: number): void {
  const remaining = endAt - Date.now();
  if (remaining > 0) {
    sleepTimer = setTimeout(() => scheduleSleepTimer(endAt), Math.min(remaining, 2_147_000_000));
    return;
  }

  expireSleepTimer(endAt);
}

function expireSleepTimer(endAt: number): void {
  if (store().sleepTimerEndsAt !== endAt || Date.now() < endAt) return;
  if (sleepTimer) clearTimeout(sleepTimer);
  sleepTimer = null;
  store().set({ sleepTimerEndsAt: null, sleepTimerPreset: null });
  playbackDelay.cancel();
  const token = ++loadToken;
  if (activePlayback) activePlayback.token = token;
  void serializeNative(async () => {
    if (token === loadToken) await TrackPlayer.pause();
  }).then(
    () => { if (token === loadToken) store().set({ status: 'paused', error: null }); },
    (error: unknown) => {
      if (token === loadToken) store().set({
        status: 'error' as const,
        error: error instanceof Error ? error.message : tr('player.sleepTimer.pauseFailed'),
      });
    },
  );
}

function checkSleepTimer(): void {
  const endAt = store().sleepTimerEndsAt;
  if (endAt !== null && Date.now() >= endAt) expireSleepTimer(endAt);
}

export function setSleepTimer(minutes: number): void {
  if (!Number.isSafeInteger(minutes) || minutes <= 0 || !Number.isSafeInteger(Date.now() + minutes * 60_000)) {
    throw new RangeError('Sleep timer duration must be a positive, safe integer number of minutes.');
  }
  if (sleepTimer) clearTimeout(sleepTimer);
  const endAt = Date.now() + minutes * 60_000;
  store().set({ sleepTimerEndsAt: endAt, sleepTimerPreset: minutes });
  scheduleSleepTimer(endAt);
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

/* ------------------------------ setup ------------------------------ */

export function setupAudio(): Promise<void> {
  if (!setupDone) {
    setupDone = (async () => {
      const settings = await settingsRepo.loadSettings(await getDb());
      try {
        await TrackPlayer.setupPlayer({
          autoHandleInterruptions: true,
          // minBuffer deve ser >= ao buffer de recuperação do ExoPlayer (5s por padrão)
          minBuffer: 10,
          maxBuffer: 15,
          playBuffer: 3,
          backBuffer: 0,
        });
      } catch (e) {
        // "already initialized" ao recarregar em dev
        if (!(e instanceof Error) || !/already been initialized/i.test(e.message)) throw e;
      }
      store().set({ repeat: settings.repeatMode });
      await TrackPlayer.updateOptions({
        // Mantém a música e a notificação do player ao fechar o app pelos recentes.
        android: { appKilledPlaybackBehavior: AppKilledPlaybackBehavior.ContinuePlayback },
        capabilities: [
          Capability.Play, Capability.Pause, Capability.SkipToNext,
          Capability.SkipToPrevious, Capability.SeekTo, Capability.Stop,
        ],
        compactCapabilities: [Capability.Play, Capability.Pause, Capability.SkipToNext],
        progressUpdateEventInterval: 1,
      });
    })().catch((e) => {
      setupDone = null;
      throw e;
    });
  }
  return setupDone;
}

/**
 * Ao reabrir o app a fila em memória está vazia, mas o TrackPlayer nativo pode ainda
 * ter a fila tocando/pausada. Reconstrói o store a partir dele para o mini player voltar.
 */
export async function restoreNativeQueue(): Promise<void> {
  await setupAudio();
  if (store().queue.items.length > 0) {
    requestRecommendationsIfEnabled();
    return;
  }

  const token = loadToken;
  const [nativeItems, index, playback, progress] = await serializeNative(() => Promise.all([
    TrackPlayer.getQueue(),
    TrackPlayer.getActiveTrackIndex(),
    TrackPlayer.getPlaybackState(),
    TrackPlayer.getProgress().catch(() => ({ position: 0, duration: 0 })),
  ]));
  if (nativeItems.length === 0 || index === undefined || index < 0 || index >= nativeItems.length) return;
  if (token !== loadToken || store().queue.items.length > 0) return;

  store().set({
    queue: { items: nativeItems.map(nativeToTrack), index },
    status: statusFromNative(playback.state),
    error: null,
  });
  const track = currentOf(store().queue);
  if (track) {
    activePlayback = {
      token,
      trackId: track.id,
      streamed: track.source === 'youtube' && /^https?:\/\//i.test(String(nativeItems[index].url)),
      position: progress.position,
      duration: Math.max(track.durationSec ?? 0, progress.duration),
    };
    automaticRetry = { trackId: track.id, attempts: 0, resumePosition: progress.position };
  }
  if (track && !historyTracker) {
    historyTracker = new PlaybackHistoryTracker(track, (item) => { void recordHistory(item); }, progress.position);
    historyTracker.setPlaying(playback.state === State.Playing);
  }
  requestRecommendationsIfEnabled();
}

function nativeToTrack(n: NativeTrack): Track {
  const id = String(n.id ?? '');
  const sep = id.indexOf(':');
  const source = id.startsWith('local:') ? 'local' : 'youtube';
  return {
    id,
    source,
    sourceId: source === 'local' && typeof n.url === 'string'
      ? n.url
      : sep >= 0 ? id.slice(sep + 1) : id,
    title: n.title ?? '',
    artist: n.artist ?? '',
    album: n.album ?? null,
    durationSec: typeof n.duration === 'number' ? n.duration : null,
    artworkUrl: typeof n.artwork === 'string' ? n.artwork : '',
  };
}

function statusFromNative(state: State): PlayerStatus {
  if (state === State.Playing) return 'playing';
  if (state === State.Paused || state === State.Ready) return 'paused';
  if (state === State.Buffering || state === State.Loading) return 'buffering';
  return 'idle';
}

/* ---------------------------- reprodução ---------------------------- */

async function loadAndPlay(track: Track, startAt = 0, isRetry = false): Promise<void> {
  playbackDelay.cancel();
  const token = ++loadToken;
  activePlayback = null;
  lastQueueEndEvent = null;
  historyTracker?.setPlaying(false);
  if (!isRetry || historyTracker?.track.id !== track.id) historyTracker = null;
  if (!isRetry || automaticRetry?.trackId !== track.id) {
    automaticRetry = { trackId: track.id, attempts: 0, resumePosition: startAt };
  } else {
    automaticRetry.resumePosition = startAt;
  }
  store().set({ status: 'loading', error: null });
  const signal = playbackDelay.begin();
  try {
    await setupAudio();
    if (token !== loadToken) return;
    await serializeNative(async () => { if (token === loadToken) await TrackPlayer.reset(); });
    if (token !== loadToken) return;
    if (track.source === 'local' && track.sourceId.startsWith('local-unavailable:')) throw new Error(tr('drive.localUnavailable'));
    const download = track.source === 'youtube' ? await resolveDownloadedTrack(track.id) : null;
    if (token !== loadToken) return;
    if (track.source === 'youtube' && !download) await waitForPlayback(signal);
    if (token !== loadToken) return;
    const stream = download
      ? { url: download.uri, mimeType: download.mimeType }
      : track.source === 'local'
        ? { url: track.sourceId, mimeType: null }
        : await catalog.getStream(track);
    if (token !== loadToken) return; // usuário já escolheu outra faixa

    await serializeNative(async () => {
      if (token !== loadToken) return;
      await TrackPlayer.add({
        id: track.id,
        url: stream.url,
        contentType: stream.mimeType?.split(';')[0],
        title: track.title,
        artist: track.artist || undefined,
        album: track.album ?? undefined,
        ...(track.artworkUrl.trim() ? { artwork: track.artworkUrl.trim() } : {}),
        duration: track.durationSec ?? undefined,
      });
      if (token !== loadToken) return;
      if (startAt > 0) await TrackPlayer.seekTo(startAt);
      if (token !== loadToken) return;
      if (!historyTracker) {
        historyTracker = new PlaybackHistoryTracker(track, (item) => { void recordHistory(item); }, startAt);
      } else {
        historyTracker.seek(startAt);
      }
      activePlayback = {
        token,
        trackId: track.id,
        streamed: track.source === 'youtube' && !download,
        position: startAt,
        duration: track.durationSec ?? 0,
      };
      await TrackPlayer.play();
    });

    if (token !== loadToken) return;
    if (!isRetry) {
      prefetchNext();
    }
  } catch (e) {
    if (token !== loadToken) return;
    if (e instanceof DownloadedTrackUnavailableError) {
      await showDownloadedTrackError(track, token, e.message);
      return;
    }
    await onTrackFailed(track, token, e instanceof Error ? e.message : tr('player.error'), startAt);
  }
}

/**
 * Mantém a faixa atual durante retries; após o limite, pausa e deixa a decisão de
 * avançar ou tentar novamente com o usuário.
 */
async function onTrackFailed(track: Track, token: number, message: string, startAt: number): Promise<void> {
  if (token !== loadToken || currentOf(store().queue)?.id !== track.id || handledFailureToken === token) return;
  handledFailureToken = token;
  historyTracker?.setPlaying(false);
  store().set({ status: 'loading', error: null });

  if (track.source === 'youtube') {
    try {
      const download = await getTrackDownloadState(track.id);
      if (token !== loadToken) return;
      if (download.status !== 'none') {
        await showDownloadedTrackError(
          track,
          token,
          download.status === 'invalid' ? tr('downloads.fileMissing') : tr('downloads.fileInvalid'),
        );
        return;
      }
    } catch (error) {
      console.error('[downloads] Could not inspect a download after playback failed', error);
    }
  }

  if (token !== loadToken || currentOf(store().queue)?.id !== track.id) return;
  if (automaticRetry?.trackId !== track.id) {
    automaticRetry = { trackId: track.id, attempts: 0, resumePosition: startAt };
  }
  if (automaticRetry.attempts < MAX_AUTOMATIC_RETRIES) {
    automaticRetry.attempts += 1;
    console.warn(`[player] Retrying ${track.id} (${automaticRetry.attempts}/${MAX_AUTOMATIC_RETRIES})`, message);
    await loadAndPlay(track, startAt, true);
    return;
  }

  try {
    await serializeNative(async () => {
      if (token === loadToken) await TrackPlayer.pause();
    });
  } catch (error) {
    console.warn('[player] Could not pause after exhausting retries', error);
  }
  if (token === loadToken && currentOf(store().queue)?.id === track.id) {
    store().set({ status: 'error', error: message });
  }
}

async function showDownloadedTrackError(track: Track, token: number, message: string): Promise<void> {
  try {
    await serializeNative(async () => {
      if (token === loadToken) await TrackPlayer.pause();
    });
  } catch (pauseError) {
    console.warn('[player] Could not pause after finding an invalid download', pauseError);
  }
  if (token !== loadToken) return;
  store().set({ status: 'error', error: message });
  void requestChoiceDialog({
    title: tr('downloads.fileMissingTitle'),
    message,
    choices: [
      { label: tr('common.cancel'), value: 'cancel' },
      { label: tr('downloads.removeRecord'), value: 'remove', destructive: true },
      { label: tr('downloads.retry'), value: 'retry' },
    ],
  }).then((choice) => {
    if (choice === 'remove') {
        void removeTrackDownload(track.id).catch((error: unknown) => {
          console.error('[downloads] Could not remove an invalid download record', error);
          store().set({
            status: 'error',
            error: error instanceof Error ? error.message : tr('common.error'),
          });
        });
    } else if (choice === 'retry') {
        let task: TrackDownloadTask;
        try {
          task = startTrackDownload(track, undefined, true);
        } catch (error) {
          store().set({
            status: 'error',
            error: error instanceof Error ? error.message : tr('common.error'),
          });
          return;
        }
        const retryToken = ++loadToken;
        store().set({ status: 'loading', error: null });
        void task.promise.then(
          () => { if (retryToken === loadToken) void loadAndPlay(track); },
          (error: unknown) => {
            if (retryToken === loadToken) store().set({
              status: 'error',
              error: error instanceof Error ? error.message : tr('common.error'),
            });
          },
        );
    }
  }).catch((error: unknown) => {
    console.error('[downloads] Could not show the invalid-download dialog', error);
  });
}

async function recordHistory(track: Track) {
  try {
    const db = await getDb();
    const s = await settingsRepo.loadSettings(db);
    if (s.historyEnabled) await historyRepo.recordPlay(db, track);
  } catch { /* histórico é best-effort */ }
}

/** Pré-resolve a próxima faixa para que a transição não espere pelo servidor. */
function prefetchNext() {
  const { queue, repeat } = store();
  prefetchArtwork(queue.items.slice(queue.index, queue.index + 4).map((track) => track.artworkUrl));
  const i = nextIndex(queue, repeat, false);
  const upcoming = i === null ? null : queue.items[i];
  if (upcoming) {
    const signal = playbackDelay.signal;
    void waitForPlayback(signal, 1000).then(() => catalog.prefetch(upcoming, signal)).catch(() => {});
  }
}

/** Fila automática: anexa sugestões ao fim da playlist, também em repeat "all". */
async function maybeFillQueue() {
  const { queue, repeat } = store();
  if ((repeat !== 'off' && repeat !== 'all') || queue.recStart !== undefined) return;
  const cur = currentOf(queue);
  if (!cur || cur.source !== 'youtube' || recommendationRequestTrackId === cur.id) return;
  recommendationRequestTrackId = cur.id;
  try {
    const related = await catalog.getRelated(cur);
    const state = store();
    const now = state.queue;
    if ((state.repeat !== 'off' && state.repeat !== 'all')
      || now.recStart !== undefined
      || currentOf(now)?.id !== cur.id) return;
    const known = new Set(now.items.map((t) => t.id));
    const fresh = related.filter((t) => !known.has(t.id));
    if (fresh.length) store().set({ queue: appendRecommended(now, fresh) });
  } finally {
    if (recommendationRequestTrackId === cur.id) recommendationRequestTrackId = null;
  }
}

function requestRecommendationsIfEnabled(): void {
  const { repeat } = store();
  if (repeat === 'off' || repeat === 'all') void maybeFillQueue().catch(() => {});
}

/** Toca `tracks` a partir de `startIndex`, substituindo a fila. */
export async function playQueue(tracks: Track[], startIndex = 0, shuffle?: boolean): Promise<void> {
  const enabled = shuffle ?? store().shuffle;
  let q = setQueue(tracks, startIndex);
  if (shuffle === true) q = shuffleAll(q);
  else if (enabled) q = shuffleRest(q);
  store().set({ queue: q, shuffle: enabled });
  requestRecommendationsIfEnabled();
  const t = currentOf(q);
  if (t) await loadAndPlay(t);
}

export const playTrack = (track: Track) => playQueue([track], 0);

export async function skipTo(index: number): Promise<void> {
  const { queue } = store();
  if (index < 0 || index >= queue.items.length) return;
  store().set({ queue: { ...queue, index } });
  await loadAndPlay(queue.items[index]);
}

export async function next(manual = true): Promise<void> {
  const { queue, repeat } = store();
  const i = nextIndex(queue, repeat, manual);
  if (i === null) {
    // fim da fila
    playbackDelay.cancel();
    const token = ++loadToken;
    try {
      await serializeNative(async () => {
        if (token !== loadToken) return;
        await TrackPlayer.pause();
        if (token === loadToken) {
          await TrackPlayer.seekTo(0);
          if (token === loadToken && activePlayback) {
            activePlayback.token = token;
            activePlayback.position = 0;
            if (automaticRetry) {
              automaticRetry.attempts = 0;
              automaticRetry.resumePosition = 0;
            }
            historyTracker?.seek(0);
            lastQueueEndEvent = null;
          }
        }
      });
      if (token === loadToken) store().set({ status: 'paused' });
    } catch (error) {
      if (token === loadToken) store().set({
        status: 'error',
        error: error instanceof Error ? error.message : tr('player.error'),
      });
    }
    return;
  }
  await skipTo(i);
}

export async function previous(): Promise<void> {
  const { queue, repeat } = store();
  const { position } = await TrackPlayer.getProgress().catch(() => ({ position: 0 }));
  if (position > 3) return void (await seekTo(0));
  const i = prevIndex(queue, repeat);
  if (i === null) return void (await seekTo(0));
  await skipTo(i);
}

export async function togglePlay(): Promise<void> {
  const timerEndAt = store().sleepTimerEndsAt;
  if (timerEndAt !== null && Date.now() >= timerEndAt) {
    expireSleepTimer(timerEndAt);
    return;
  }
  const { status, queue } = store();
  if (status === 'error' || status === 'idle') {
    const t = currentOf(queue);
    if (t) {
      const position = activePlayback?.trackId === t.id ? activePlayback.position : 0;
      await loadAndPlay(t, position);
    }
    return;
  }
  await serializeNative(async () => {
    const { state } = await TrackPlayer.getPlaybackState();
    if (state === State.Playing || state === State.Buffering || state === State.Loading) await TrackPlayer.pause();
    else await TrackPlayer.play();
  });
}

export const play = () => serializeNative(() => TrackPlayer.play());
export const pause = () => serializeNative(() => TrackPlayer.pause());
export const seekTo = (sec: number) => serializeNative(async () => {
  const tracker = historyTracker;
  tracker?.setPlaying(false);
  try {
    await TrackPlayer.seekTo(sec);
    tracker?.seek(sec);
    if (activePlayback?.token === loadToken) activePlayback.position = sec;
    if (automaticRetry) automaticRetry.resumePosition = sec;
  } finally {
    if (tracker === historyTracker) tracker?.setPlaying(store().status === 'playing');
  }
});

export async function stop(): Promise<void> {
  playbackDelay.cancel();
  const token = ++loadToken;
  activePlayback = null;
  automaticRetry = null;
  historyTracker?.setPlaying(false);
  historyTracker = null;
  cancelSleepTimer();
  try {
    await serializeNative(async () => {
      if (token === loadToken) await TrackPlayer.reset();
    });
    if (token === loadToken) store().set({ queue: emptyQueue, status: 'idle', error: null });
  } catch (error) {
    if (token === loadToken) store().set({
      status: 'error',
      error: error instanceof Error ? error.message : tr('player.error'),
    });
  }
}

/* --------------------------- fila / opções --------------------------- */

export function addToQueueNext(track: Track) {
  const wasEmpty = store().queue.items.length === 0;
  store().set({ queue: qPlayNext(store().queue, track) });
  requestRecommendationsIfEnabled();
  if (wasEmpty) void loadAndPlay(track);
  else prefetchNext();
}

export function addToQueueEnd(tracks: Track[]) {
  const wasEmpty = store().queue.items.length === 0;
  store().set({ queue: qEnqueue(store().queue, tracks) });
  requestRecommendationsIfEnabled();
  if (wasEmpty) void loadAndPlay(tracks[0]);
  else prefetchNext();
}

export async function removeFromQueue(index: number): Promise<void> {
  const { queue } = store();
  const removingCurrent = index === queue.index;
  const q = removeAt(queue, index);
  store().set({ queue: q });
  if (removingCurrent) {
    const t = currentOf(q);
    if (t) await loadAndPlay(t);
    else await stop();
  } else {
    prefetchNext();
  }
}

export async function reorderQueue(from: number, to: number): Promise<void> {
  const queue = store().queue;
  const nextQueue = moveQueueItem(queue, from, to);
  if (nextQueue === queue) return;
  await serializeNative(() => TrackPlayer.move(from, to));
  store().set({ queue: nextQueue });
  prefetchNext();
}

export function toggleShuffle() {
  const { queue, shuffle } = store();
  store().set({
    queue: shuffle ? restoreShuffleOrder(queue) : shuffleRest(queue),
    shuffle: !shuffle,
  });
  prefetchNext();
}

export async function setRepeat(mode: RepeatMode) {
  store().set({ repeat: mode });
  requestRecommendationsIfEnabled();
  prefetchNext();
  try { await settingsRepo.saveSetting(await getDb(), 'repeatMode', mode); } catch { /* */ }
}

/* ------------------------- eventos do player ------------------------- */

/**
 * Fim da faixa nativa. Um evento atrasado (enquanto a próxima faixa ainda carrega, ou de uma
 * faixa já substituída) não pode avançar a fila de novo, senão a faixa seguinte é pulada.
 */
async function onQueueEnded(event: { track: number; position: number }): Promise<void> {
  const token = loadToken;
  const cur = currentOf(store().queue);
  if (!cur
    || store().status === 'loading'
    || store().status === 'error'
    || handledFailureToken === token
    || activePlayback?.token !== token
    || queueEndToken === token
    || isDuplicateQueueEnd(event, lastQueueEndEvent, Date.now())) return;
  queueEndToken = token;
  try {
    const [active, progress, playback] = await Promise.all([
      TrackPlayer.getActiveTrack().catch(() => undefined),
      TrackPlayer.getProgress().catch(() => ({ position: 0, duration: 0 })),
      TrackPlayer.getPlaybackState().catch(() => null),
    ]);
    if (token !== loadToken || handledFailureToken === token
      || currentOf(store().queue)?.id !== cur.id || !active || String(active.id) !== cur.id) return;
    // Um evento antigo não pode terminar uma tentativa que já está a tocar.
    if (playback?.state === State.Playing || playback?.state === State.Buffering || playback?.state === State.Loading) return;
    lastQueueEndEvent = queueEndSignature(event, Date.now());
    const session = activePlayback;
    if (!session || session.token !== token || session.trackId !== cur.id) return;
    const position = Math.max(event.position, progress.position, session.position);
    const duration = Math.max(cur.durationSec ?? 0, progress.duration, session.duration);
    session.position = position;
    if (session.streamed && Number.isFinite(duration) && duration > 0
      && position + TRACK_END_TOLERANCE_SECONDS < duration) {
      await onTrackFailed(cur, token, tr('player.streamInterrupted'), position);
      return;
    }
    if (store().sleepTimerPreset === 'trackEnd') {
      store().set({ sleepTimerEndsAt: null, sleepTimerPreset: null, status: 'paused' });
      return;
    }
    if (store().repeat === 'one') {
      try {
        await serializeNative(async () => {
          if (token !== loadToken || currentOf(store().queue)?.id !== cur.id || store().repeat !== 'one') return;
          await TrackPlayer.seekTo(0);
          session.position = 0;
          if (automaticRetry) automaticRetry.resumePosition = 0;
          historyTracker = new PlaybackHistoryTracker(cur, (item) => { void recordHistory(item); });
          await TrackPlayer.play();
          historyTracker.setPlaying(true);
        });
        if (token === loadToken && currentOf(store().queue)?.id === cur.id && store().repeat === 'one') {
          store().set({ status: 'playing', error: null });
        }
      } catch (error) {
        if (token === loadToken && currentOf(store().queue)?.id === cur.id) {
          store().set({
            status: 'error',
            error: error instanceof Error ? error.message : tr('player.error'),
          });
        }
      }
      return;
    }
    if (shouldFetchRecommendations(store().queue, store().repeat)) {
      await maybeFillQueue().catch(() => {});
      if (token !== loadToken || currentOf(store().queue)?.id !== cur.id) return;
    }
    await next(false);
  } finally {
    if (queueEndToken === token) queueEndToken = null;
  }
}

/** Registrado pelo playbackService (roda também em background/headless). */
export function attachPlayerEvents() {
  TrackPlayer.addEventListener(Event.PlaybackQueueEnded, (event) => { void onQueueEnded(event); });

  TrackPlayer.addEventListener(Event.PlaybackState, ({ state }) => {
    historyTracker?.setPlaying(state === State.Playing);
    const cur = store().status;
    if (cur === 'error' || handledFailureToken === loadToken) return;
    if (cur === 'loading') {
      if (state === State.Playing) store().set({ status: 'playing' });
      return;
    }
    if (state === State.Playing) store().set({ status: 'playing' });
    else if (state === State.Paused || state === State.Ready) store().set({ status: 'paused' });
    else if (state === State.Buffering || state === State.Loading) store().set({ status: 'buffering' });
  });

  TrackPlayer.addEventListener(Event.PlaybackProgressUpdated, async ({ position, duration }) => {
    checkSleepTimer();
    const token = loadToken;
    const tracker = historyTracker;
    const [active, playback] = await Promise.all([
      TrackPlayer.getActiveTrack().catch(() => undefined),
      TrackPlayer.getPlaybackState().catch(() => null),
    ]);
    if (token !== loadToken || !active || String(active.id) !== currentOf(store().queue)?.id) return;
    const session = activePlayback;
    if (!session || session.token !== token || session.trackId !== String(active.id)
      || handledFailureToken === token || playback?.state !== State.Playing) return;
    session.position = position;
    if (Number.isFinite(duration) && duration > 0) session.duration = Math.max(session.duration, duration);
    if (tracker === historyTracker && tracker?.track.id === String(active.id)) {
      tracker.update(position, duration);
    }
    const retry = automaticRetry;
    // Só movimento real após a posição retomada confirma que o retry funcionou.
    if (!retry || position <= retry.resumePosition || currentOf(store().queue)?.id !== retry.trackId) return;
    if (token === loadToken && active && String(active.id) === retry.trackId && automaticRetry === retry) {
      retry.attempts = 0;
    }
  });

  // URL expirada / falha de rede: re-resolve o stream na mesma posição até ao limite.
  TrackPlayer.addEventListener(Event.PlaybackError, async (e) => {
    console.warn('[player] PlaybackError', e.code, e.message);
    const message = tr('player.errorTrack', { detail: `${e.message ?? ''} (${e.code ?? '?'})` });
    const t = currentOf(store().queue);
    if (!t) return;
    const token = loadToken;
    const session = activePlayback;
    if (!session || session.token !== token || session.trackId !== t.id) return;
    const active = await TrackPlayer.getActiveTrack().catch(() => undefined);
    if (token !== loadToken || (active && String(active.id) !== t.id)) return;
    const { position } = await TrackPlayer.getProgress().catch(() => ({ position: 0 }));
    await onTrackFailed(t, token, message, position > 0 ? position : session.position);
  });

  TrackPlayer.addEventListener(Event.RemoteNext, () => { void next(true); });
  TrackPlayer.addEventListener(Event.RemotePrevious, () => { void previous(); });
  TrackPlayer.addEventListener(Event.RemotePlay, () => { void togglePlay(); });
  TrackPlayer.addEventListener(Event.RemotePause, () => { void pause(); });
  TrackPlayer.addEventListener(Event.RemoteStop, () => { void stop(); });
  TrackPlayer.addEventListener(Event.RemoteSeek, ({ position }) => { void seekTo(position); });
}
