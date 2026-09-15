export function normalizeRecordingMimeType(mimeType: string): string {
  const baseType = mimeType.split(';', 1)[0]?.trim().toLowerCase();
  return baseType || 'audio/webm';
}
