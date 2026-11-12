import { saveWebFile } from '@/storage/webFiles';
export async function saveCloudSafety(bytes: Uint8Array): Promise<void> {
  await saveWebFile('web-backup:lify-cloud-safety', new Blob([Uint8Array.from(bytes).buffer]), 'lify-cloud-safety.lifybackup');
}
