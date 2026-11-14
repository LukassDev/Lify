import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import { loadSupabaseSync, resumeSupabaseSync } from '@/storage/supabase/sync';

export function SupabaseSyncObserver() {
  useEffect(() => {
    void loadSupabaseSync();
    const subscription = AppState.addEventListener('change', (state) => { void resumeSupabaseSync(state === 'active'); });
    const online = () => { void resumeSupabaseSync(true); };
    if (Platform.OS === 'web') window.addEventListener('online', online);
    return () => { subscription.remove(); if (Platform.OS === 'web') window.removeEventListener('online', online); };
  }, []);
  return null;
}
