export function validateSupabaseConfig(url: string, key: string): { url: string; key: string } {
  const parsed = new URL(url.trim());
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error('Use a URL HTTPS do projeto Supabase (sem caminhos).');
  const value = key.trim();
  if (value.startsWith('sb_secret_')) throw new Error('Use a chave publishable/anon. Nunca use secret ou service_role no Lify.');
  if (!value.startsWith('sb_publishable_')) {
    try {
      const payload = JSON.parse(atob(value.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (payload.role !== 'anon') throw new Error();
    } catch { throw new Error('Use a chave pública publishable ou anon do projeto.'); }
  }
  if (value.length < 20) throw new Error('Chave pública inválida.');
  return { url: parsed.origin, key: value };
}
