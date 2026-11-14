export const supabaseSessionStorage = {
  async getItem(key: string): Promise<string | null> { return window.localStorage.getItem(key); },
  async setItem(key: string, value: string): Promise<void> { window.localStorage.setItem(key, value); },
  async removeItem(key: string): Promise<void> { window.localStorage.removeItem(key); },
};
