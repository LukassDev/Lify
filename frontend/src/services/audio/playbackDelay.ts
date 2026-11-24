/** A new selection cancels both the pending delay and work tied to the old selection. */
export class PlaybackDelay {
  private controller = new AbortController();

  get signal(): AbortSignal { return this.controller.signal; }

  cancel(): void { this.controller.abort(); }

  begin(): AbortSignal {
    this.cancel();
    this.controller = new AbortController();
    return this.controller.signal;
  }
}

export function waitForPlayback(signal: AbortSignal, milliseconds = 300): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(Object.assign(new Error('Playback cancelled'), { name: 'AbortError' }));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
