import 'react-native-url-polyfill/auto';
import { createClient, processLock, type SupabaseClient, type RealtimeChannel } from '@supabase/supabase-js';
import { Platform } from 'react-native';
import { create } from 'zustand';
import { getDb, settingsRepo } from '@/database';
import { getDeviceState, setDeviceState } from '@/database/device';
import { setLanguage } from '@/i18n';
import { notifyLibraryRestored } from '@/utils/libraryEvents';
import { bumpFavoritesVersion } from '@/features/favorites/favoriteFeedback';
import { disconnectDrive, loadDrivePreferences, useDriveStore } from '@/storage/drive/sync';
import { validateSupabaseConfig } from './config';
import { withProviderActivation } from '../providerActivation';
import { supabaseSessionStorage } from './sessionStorage';
import { acknowledgeOutbox, applyRemoteRows, replaceLocalReplicaFromCloud, initializeReplica, initializeReplicaFromLocal, readOutbox, type RemoteRow } from './repository';

interface Config { url: string; key: string; enabled: boolean; restoreOnReconnect?: boolean }
const defaults: Config = { url: '', key: '', enabled: false };
interface SyncState extends Config {
  loaded: boolean; email: string | null; userId: string | null; busy: boolean;
  status: 'off' | 'connecting' | 'live' | 'waiting'; error: string | null; pending: number; lastSyncAt: number | null;
  network?: 'checking' | 'online' | 'offline'; localMode?: boolean;
}
export const useSupabaseSync = create<SyncState>(() => ({ ...defaults, loaded: false, email: null, userId: null, busy: false, status: 'off', error: null, pending: 0, lastSyncAt: null }));
let client: SupabaseClient | null = null;
let boot: Promise<void> | null = null;
let authUnsubscribe: (() => void) | null = null;
let channel: RealtimeChannel | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let generation = 0;
let cycling = false;
let needsPull = true;
let lastPull = 0;
let activeUser: string | null = null;
let retryAt = 0;
let realtimeConnected = false;
const cycleWaiters = new Set<() => void>();

async function persist(patch: Partial<Config>): Promise<void> {
  const state = useSupabaseSync.getState();
  const config = { url: state.url, key: state.key, enabled: state.enabled, restoreOnReconnect: state.restoreOnReconnect, ...patch };
  await setDeviceState('supabaseSync', config);
  useSupabaseSync.setState(config);
}

function stop(): void {
  generation++;
  if (timer) clearInterval(timer);
  timer = null;
  if (channel && client) void client.removeChannel(channel);
  channel = null;
  activeUser = null;
  realtimeConnected = false;
  useSupabaseSync.setState({ status: 'off' });
}

function makeClient(config: Config): SupabaseClient {
  const instance = createClient(config.url, config.key, { global: { fetch: async (input, init) => {
    try { return await globalThis.fetch(input, init); }
    catch (error) { useSupabaseSync.setState({ network: 'offline' }); throw error; }
  } }, auth: {
    storage: supabaseSessionStorage, storageKey: 'lify.supabase.' + new URL(config.url).hostname,
    persistSession: true, autoRefreshToken: true, detectSessionInUrl: false,
    ...(Platform.OS !== 'web' ? { lock: processLock } : {}),
  } });
  const { data } = instance.auth.onAuthStateChange((event, session) => {
    useSupabaseSync.setState({ email: session?.user.email ?? null, userId: session?.user.id ?? null });
    if (event === 'SIGNED_OUT') {
      stop();
    }
  });
  authUnsubscribe = () => data.subscription.unsubscribe();
  return instance;
}

export async function loadSupabaseSync(): Promise<void> {
  if (useSupabaseSync.getState().loaded) return;
  if (!boot) boot = (async () => {
    const config = await getDeviceState<Config>('supabaseSync', defaults);
    useSupabaseSync.setState({ ...defaults, ...config, loaded: true });
    if (!config.url || !config.key) return;
    client = makeClient(validateSupabaseConfig(config.url, config.key) as Config);
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    useSupabaseSync.setState({ email: data.session?.user.email ?? null, userId: data.session?.user.id ?? null });
    if (config.enabled && data.session) await start(data.session.user.id);
    else if (config.enabled) useSupabaseSync.setState({ status: 'waiting', error: 'Entre novamente na conta Supabase para retomar a sincronização.' });
  })().catch((error: unknown) => {
    useSupabaseSync.setState({ error: error instanceof Error ? error.message : String(error), status: 'waiting' });
  }).finally(() => { boot = null; });
  return boot;
}

export async function configureSupabase(url: string, key: string): Promise<void> {
  await loadSupabaseSync();
  if (useSupabaseSync.getState().userId) throw new Error('Saia da conta antes de mudar de projeto Supabase.');
  const config = validateSupabaseConfig(url, key);
  stop();
  authUnsubscribe?.();
  await persist({ ...config, enabled: false });
  client = makeClient({ ...config, enabled: false });
}

export async function authenticateSupabase(email: string, password: string, signup: boolean): Promise<string> {
  await loadSupabaseSync();
  if (!client) throw new Error('Guarde primeiro a URL e a chave pública do projeto.');
  const credentials = { email: email.trim(), password };
  const result = signup ? await client.auth.signUp(credentials) : await client.auth.signInWithPassword(credentials);
  if (result.error) throw result.error;
  useSupabaseSync.setState({ email: result.data.session?.user.email ?? null, userId: result.data.session?.user.id ?? null });
  if (result.data.session && useSupabaseSync.getState().enabled) await start(result.data.session.user.id);
  return result.data.session ? 'Conta ligada. Ative a sincronização nos dois dispositivos.' : 'Conta criada. Confirme o email e depois entre no Lify.';
}

export async function signOutSupabase(): Promise<void> {
  stop();
  await persist({ enabled: false });
  if (client) {
    const { error } = await client.auth.signOut({ scope: 'local' });
    if (error) throw error;
  }
  useSupabaseSync.setState({ email: null, userId: null });
}

async function fetchPage(userId: string, cursor: number): Promise<RemoteRow[]> {
  if (!client) throw new Error('Supabase não configurado.');
  const { data, error } = await client.from('lify_sync_records').select('kind,entity_key,payload,version').eq('user_id', userId).gt('version', cursor).order('version').limit(200);
  if (error) throw new Error(`${error.message}. Confirme que executou o SQL de configuração do Lify neste projeto.`);
  return (data ?? []) as RemoteRow[];
}

export async function enableSupabaseSync(enabled: boolean): Promise<void> {
  if (enabled) return withProviderActivation(() => activateSupabaseSync(true));
  return activateSupabaseSync(false);
}

async function activateSupabaseSync(enabled: boolean): Promise<void> {
  await loadSupabaseSync();
  if (!enabled) {
    stop();
    useSupabaseSync.setState({ localMode: false });
    await persist({ enabled: false });
    if (cycling) await new Promise<void>((resolve) => cycleWaiters.add(resolve));
    return;
  }
  if (!client) throw new Error('Configure o projeto e entre na sua conta.');
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw new Error('Entre na sua conta Supabase antes de ativar a sincronização.');
  await loadDrivePreferences();
  if (useDriveStore.getState().busy) throw new Error('Aguarde a operação Google Drive terminar antes de trocar de serviço.');
  const switchingFromDrive = useDriveStore.getState().connected;
  // Validate the destination before disconnecting the current provider.
  const remote: RemoteRow[] = [];
  let cursor = 0;
  while (true) {
    const page = await fetchPage(data.user.id, cursor);
    remote.push(...page);
    if (page.length < 200) break;
    cursor = Number(page[page.length - 1].version);
  }
  const state = useSupabaseSync.getState();
  if (switchingFromDrive) await disconnectDrive();
  const initialize = switchingFromDrive ? initializeReplicaFromLocal : initializeReplica;
  await initialize(await getDb(), state.url + '|' + data.user.id, remote);
  await persist({ enabled: true, ...(switchingFromDrive ? { restoreOnReconnect: false } : {}) });
  useSupabaseSync.setState({ localMode: false, network: 'checking' });
  await start(data.user.id);
}

async function start(userId: string): Promise<void> {
  stop();
  activeUser = userId;
  retryAt = 0;
  needsPull = true;
  const owner = useSupabaseSync.getState().url + '|' + userId;
  const control = await (await getDb()).getFirstAsync<{ owner: string | null }>('SELECT owner FROM realtime_control WHERE id=1');
  if (control?.owner !== owner) {
    await persist({ enabled: false });
    throw new Error('A biblioteca está associada a outra conta/projeto. Ative a sincronização para confirmar a nova associação.');
  }
  useSupabaseSync.setState({ status: 'connecting', error: null });
  const channelGeneration = generation;
  channel = client!.channel('lify-library-' + userId).on('postgres_changes', {
    event: '*', schema: 'public', table: 'lify_sync_records', filter: 'user_id=eq.' + userId,
  }, () => { needsPull = true; void cycle(); }).subscribe((status) => {
    if (channelGeneration !== generation) return;
    if (status === 'SUBSCRIBED') { realtimeConnected = true; retryAt = 0; needsPull = true; void cycle(); }
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      realtimeConnected = false;
      useSupabaseSync.setState({ status: 'waiting', error: 'Realtime desligado. As alterações serão recuperadas ao voltar a ligar.' });
    }
  });
  timer = setInterval(() => { void cycle(); }, 1000);
  await cycle();
}

export async function resumeSupabaseSync(active: boolean): Promise<void> {
  await loadSupabaseSync();
  if (Platform.OS !== 'web') {
    if (active) client?.auth.startAutoRefresh(); else client?.auth.stopAutoRefresh();
  }
  if (active) {
    retryAt = 0; needsPull = true;
    if (!activeUser && client && useSupabaseSync.getState().enabled) {
      const { data } = await client.auth.getSession();
      if (data.session) await start(data.session.user.id);
    }
    await cycle();
  }
}

async function cycle(): Promise<void> {
  if (cycling || !client || !activeUser || !useSupabaseSync.getState().enabled || Date.now() < retryAt) return;
  const current = generation, userId = activeUser;
  const alive = () => current === generation && useSupabaseSync.getState().enabled;
  cycling = true;
  try {
    const db = await getDb();
    if (db.isInTransactionSync()) return;
    if (!await checkSupabaseConnection()) return;
    if (useSupabaseSync.getState().restoreOnReconnect) {
      useSupabaseSync.setState({ localMode: false, network: 'checking' });
      const cloud: RemoteRow[] = [];
      let cursor = 0;
      while (alive()) {
        const page = await fetchPage(userId, cursor);
        cloud.push(...page);
        if (page.length < 200) break;
        cursor = Number(page[page.length - 1].version);
      }
      if (!alive()) return;
      await replaceLocalReplicaFromCloud(db, cloud);
      await persist({ restoreOnReconnect: false });
      setLanguage((await settingsRepo.loadSettings(db)).language);
      bumpFavoritesVersion(); notifyLibraryRestored();
      useSupabaseSync.setState({ network: 'online', localMode: false, pending: 0 });
    }
    const pending = await readOutbox(db);
    useSupabaseSync.setState({ pending: Number((await db.getFirstAsync<{ n: number }>('SELECT count(*) n FROM realtime_outbox'))?.n ?? 0) });
    if (!pending.length && !needsPull && Date.now() - lastPull < 30000) return;
    if (!alive()) return;
    if (pending.length) {
      const { error } = await client.rpc('lify_apply_changes', { changes: pending.map((row) => ({ ...row, payload: row.payload === null ? null : JSON.parse(row.payload) })) });
      if (error) throw error;
      if (!alive()) return;
      await acknowledgeOutbox(db, pending);
    }
    needsPull = false;
    let updated = false;
    while (alive()) {
      const cursor = Number((await db.getFirstAsync<{ cursor: number }>('SELECT cursor FROM realtime_control WHERE id=1'))?.cursor ?? 0);
      const page = await fetchPage(userId, cursor);
      if (!alive()) return;
      if (page.length) { await applyRemoteRows(db, page); updated = true; }
      if (page.length < 200) break;
    }
    if (updated) {
      setLanguage((await settingsRepo.loadSettings(db)).language);
      bumpFavoritesVersion();
      notifyLibraryRestored();
    }
    lastPull = Date.now();
    if (alive()) useSupabaseSync.setState({ status: realtimeConnected ? 'live' : 'connecting', error: null, lastSyncAt: Date.now(), pending: Number((await db.getFirstAsync<{ n: number }>('SELECT count(*) n FROM realtime_outbox'))?.n ?? 0) });
  } catch (error) {
    if (alive()) useSupabaseSync.setState({ status: 'waiting', error: error instanceof Error ? error.message : String(error) });
    // Keep the durable outbox; retry after reconnection, without rolling back local edits.
    needsPull = true;
    retryAt = Date.now() + 5000;
  } finally { cycling = false; cycleWaiters.forEach((resolve) => resolve()); cycleWaiters.clear(); }
}

let probing: Promise<boolean> | null = null;
let lastProbe = 0;
export async function checkSupabaseConnection(force = false): Promise<boolean> {
  if (probing) return probing;
  const state = useSupabaseSync.getState();
  if (!force && Date.now() - lastProbe < 5000) return state.network === 'online';
  probing = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await globalThis.fetch(state.url + '/auth/v1/health', { headers: { apikey: state.key }, signal: controller.signal, cache: 'no-store' });
      const online = response.status < 500;
      useSupabaseSync.setState({ network: online ? 'online' : 'offline' });
      return online;
    } catch { useSupabaseSync.setState({ network: 'offline' }); return false; }
    finally { clearTimeout(timeout); lastProbe = Date.now(); probing = null; }
  })();
  return probing;
}

export async function continueWithLocalSupabaseLibrary(): Promise<void> {
  await persist({ restoreOnReconnect: true });
  useSupabaseSync.setState({ localMode: true });
}
