import * as SecureStore from 'expo-secure-store';
const prefix = 'lify.supabase.session';
// Chunk sessions because some native keychains limit the size of individual values.
export const supabaseSessionStorage = {
  async getItem(_key: string): Promise<string | null> {
    const count = Number(await SecureStore.getItemAsync(prefix + '.count'));
    if (!Number.isInteger(count) || count < 1 || count > 64) return null;
    const parts = await Promise.all(Array.from({ length: count }, (_, index) => SecureStore.getItemAsync(prefix + '.' + index)));
    return parts.some((part) => part === null) ? null : parts.join('');
  },
  async setItem(_key: string, value: string): Promise<void> {
    await this.removeItem(_key);
    const parts = value.match(/[\s\S]{1,1500}/g) ?? [];
    for (let index = 0; index < parts.length; index++) await SecureStore.setItemAsync(prefix + '.' + index, parts[index]);
    await SecureStore.setItemAsync(prefix + '.count', String(parts.length));
  },
  async removeItem(_key: string): Promise<void> {
    const count = Math.min(64, Number(await SecureStore.getItemAsync(prefix + '.count')) || 0);
    await SecureStore.deleteItemAsync(prefix + '.count');
    for (let index = 0; index < count; index++) await SecureStore.deleteItemAsync(prefix + '.' + index);
  },
};
