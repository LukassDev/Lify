import type { Track } from '@/types';

/** Conta uma reprodução apenas depois de ouvir metade da duração da faixa. */
export class PlaybackHistoryTracker {
  private listenedSeconds = 0;
  private recorded = false;
  private playing = false;
  private lastPosition: number;
  private lastUpdatedAt: number | null = null;

  constructor(
    readonly track: Track,
    private readonly record: (track: Track) => void,
    startAt = 0,
  ) {
    this.lastPosition = startAt;
  }

  setPlaying(playing: boolean): void {
    if (this.playing === playing) return;
    this.playing = playing;
    this.lastUpdatedAt = playing ? Date.now() : null;
  }

  seek(position: number): void {
    this.lastPosition = position;
    this.lastUpdatedAt = this.playing ? Date.now() : null;
  }

  update(position: number, duration: number): void {
    if (!this.playing || this.recorded || !Number.isFinite(position)) return;
    const now = Date.now();
    if (this.lastUpdatedAt !== null) {
      const advanced = Math.max(0, position - this.lastPosition);
      const elapsed = Math.max(0, (now - this.lastUpdatedAt) / 1000);
      // Saltar na barra de progresso não equivale a ouvir esse intervalo.
      this.listenedSeconds += Math.min(advanced, elapsed);
    }
    this.lastPosition = position;
    this.lastUpdatedAt = now;

    const durationSeconds = Number.isFinite(duration) && duration > 0
      ? duration
      : this.track.durationSec;
    if (durationSeconds && Number.isFinite(durationSeconds) && durationSeconds > 0
      && this.listenedSeconds >= durationSeconds / 2) {
      this.recorded = true;
      this.record(this.track);
    }
  }
}
