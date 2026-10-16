// A small, structurally valid MP4 (ftyp + moov + mdat) for tests that need "a video file" without a codec or a real clip.
// It satisfies the container check NAgex applies to a downloaded video; it is not playable footage.
function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, payload]);
}

export function makeMp4(options: { dataBytes?: number; fill?: number } = {}): Buffer {
  const ftyp = box('ftyp', Buffer.concat([Buffer.from('isom', 'latin1'), Buffer.from([0, 0, 2, 0]), Buffer.from('isomiso2avc1mp41', 'latin1')]));
  const moov = box('moov', box('mvhd', Buffer.alloc(100)));
  const mdat = box('mdat', Buffer.alloc(options.dataBytes ?? 4096, options.fill ?? 0x5a));
  return Buffer.concat([ftyp, moov, mdat]);
}
