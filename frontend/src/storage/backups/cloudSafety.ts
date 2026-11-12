import { Directory, File, Paths } from 'expo-file-system';
export async function saveCloudSafety(bytes: Uint8Array): Promise<void> {
  const dir = new Directory(Paths.document, 'backups');
  dir.create({ intermediates: true, idempotent: true });
  const file = new File(dir, 'lify-cloud-safety.lifybackup');
  file.create({ overwrite: true });
  file.write(bytes);
}
