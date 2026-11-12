/** An empty download list means the backup deliberately omitted downloaded audio. */
export function downloadRestoreMode(
  trackIds: string[],
  downloadUris?: Map<string, string>,
): 'omit' | 'restore' | 'invalid' {
  if (!downloadUris || downloadUris.size === 0) return 'omit';
  if (downloadUris.size !== trackIds.length) return 'invalid';
  return trackIds.every((id) => downloadUris.has(id)) ? 'restore' : 'invalid';
}
