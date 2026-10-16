import crypto from 'node:crypto';
import { VideoProviderError } from './providers/video-provider-error.js';

// A downloaded "video" is accepted only if it really is an MP4 (ISO base media file): the first box is `ftyp`, the boxes tile the whole file with no
// overrun (a truncated download fails here), and a `moov` box exists. This is a structural check, not a decode - it refuses an HTML error page,
// an empty body, a cut-off transfer and a different container, which are the failures a provider hand-off actually produces.

export const MAX_VIDEO_BYTES = 300 * 1024 * 1024;

export interface ValidatedVideo {
  bytes: Buffer;
  mimeType: 'video/mp4';
  byteLength: number;
  sha256: string;
  majorBrand: string;
}

export function validateMp4(bytes: Buffer): ValidatedVideo {
  if (!bytes || bytes.length < 16) throw new VideoProviderError('MEDIA_INVALID', 'The downloaded file is empty or too small to be a video.');
  if (bytes.length > MAX_VIDEO_BYTES) throw new VideoProviderError('MEDIA_INVALID', 'The downloaded video is larger than the allowed size.');

  let offset = 0;
  let sawFtyp = false;
  let sawMoov = false;
  let majorBrand = '';
  while (offset < bytes.length) {
    if (bytes.length - offset < 8) throw new VideoProviderError('MEDIA_INVALID', 'The downloaded video ends in the middle of a data block (it is cut off).');
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      if (bytes.length - offset < 16) throw new VideoProviderError('MEDIA_INVALID', 'The downloaded video is cut off.');
      const big = bytes.readBigUInt64BE(offset + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new VideoProviderError('MEDIA_INVALID', 'The downloaded video declares an impossible size.');
      size = Number(big);
      header = 16;
    } else if (size === 0) {
      size = bytes.length - offset; // the last box runs to the end of the file
    }
    if (size < header || offset + size > bytes.length) throw new VideoProviderError('MEDIA_INVALID', 'The downloaded video is cut off or damaged.');
    if (!/^[\x20-\x7e]{4}$/.test(type)) throw new VideoProviderError('MEDIA_INVALID', 'The downloaded file is not a video (unknown data block).');
    if (offset === 0) {
      if (type !== 'ftyp') throw new VideoProviderError('MEDIA_INVALID', 'The downloaded file is not an MP4 video.');
      sawFtyp = true;
      majorBrand = bytes.toString('latin1', offset + header, offset + header + 4);
    }
    if (type === 'moov') sawMoov = true;
    offset += size;
  }
  if (!sawFtyp || !sawMoov) throw new VideoProviderError('MEDIA_INVALID', 'The downloaded file is an incomplete MP4 (no movie data block).');
  return { bytes, mimeType: 'video/mp4', byteLength: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), majorBrand };
}
