const listeners = new Set<() => void>();
export function subscribeLibraryRestored(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function notifyLibraryRestored(): void { listeners.forEach((listener) => listener()); }
