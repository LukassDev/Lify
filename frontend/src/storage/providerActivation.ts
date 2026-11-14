let activating = false;
/** Keep provider activation mutually exclusive even if two settings panels are used quickly. */
export async function withProviderActivation<T>(action: () => Promise<T>): Promise<T> {
  if (activating) throw new Error('Aguarde a troca de serviço de sincronização terminar.');
  activating = true;
  try { return await action(); } finally { activating = false; }
}
