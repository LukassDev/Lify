/** Deduplicate entry events and defer a pending sync until other Drive work finishes. */
export function createEntrySync(options: {
  ready: () => boolean;
  synchronize: () => Promise<unknown>;
  onStart: () => void;
  onError: (error: unknown) => void;
}) {
  let active = true;
  let running = false;
  let pending = true;
  async function drain(): Promise<void> {
    if (!active || running || !pending || !options.ready()) return;
    running = true;
    pending = false;
    options.onStart();
    try { await options.synchronize(); }
    catch (error) { if (active) options.onError(error); }
    finally { running = false; }
  }
  return {
    drain,
    request() {
      // OAuth popup visibility events belong to the current operation.
      if (running || !active) return;
      pending = true;
      void drain();
    },
    dispose() { active = false; },
  };
}
