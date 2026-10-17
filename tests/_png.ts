// Small real images for tests, with no dependency: a valid PNG (IHDR + zlib-compressed scanlines + CRC) whose pixels a callback decides, and the header of a JPEG (enough for the size reader).
import zlib from 'node:zlib';
import { crc32 } from '../src/creation/pptx/zip-writer.js';

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

export function makePng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number] = () => [10, 86, 247]): Buffer {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) { const [r, g, b] = pixel(x, y); const o = y * stride + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Vertical bars on white: something a person can see is a chart-like picture. */
export function makeBarsPng(width: number, height: number, values: number[]): Buffer {
  const slot = Math.floor(width / values.length);
  return makePng(width, height, (x, y) => {
    const i = Math.min(values.length - 1, Math.floor(x / slot));
    const within = x % slot;
    const barTop = height - Math.round(values[i] * (height - 40)) - 20;
    return within > slot * 0.2 && within < slot * 0.8 && y > barTop && y < height - 20 ? [10, 86, 247] : [255, 255, 255];
  });
}

/** The first bytes of a JPEG up to and including its start-of-frame marker: enough for a size reader, not a picture anyone can open. */
export function jpegHeader(width: number, height: number): Buffer {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]), sof]);
}
