// What a picture IS, read from its bytes and nothing else: a PNG or a JPEG, and its size. A stored mime type or a file name is never trusted: a document or a deck embeds only what this recognises, so
// a hostile or mislabelled file (a GIF with a .png name, an HEIF, an ICNS) is refused before any office library or viewer parses it.
export interface ImageInfo { width: number; height: number; extension: 'png' | 'jpeg' }

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function imageSize(bytes: Buffer): ImageInfo | null {
  if (bytes.length > 24 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height, extension: 'png' } : null;
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i += 1; continue; }
      const marker = bytes[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const length = bytes.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = bytes.readUInt16BE(i + 5); const width = bytes.readUInt16BE(i + 7);
        return width > 0 && height > 0 ? { width, height, extension: 'jpeg' } : null;
      }
      i += 2 + length;
    }
  }
  return null;
}
