// Width and height of a PNG or JPEG from its header, so the strip can be sized without an image library.

export function imageSize(b: Uint8Array): { width: number; height: number } {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  // PNG: 8-byte signature, then the IHDR chunk with width and height (big-endian).
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { width: v.getUint32(16), height: v.getUint32(20) };
  // JPEG: walk the segments to the first start-of-frame marker (SOF0–SOF15 except DHT/JPG/DAC).
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1]!;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: v.getUint16(i + 5), width: v.getUint16(i + 7) };
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      i += 2 + v.getUint16(i + 2);
    }
  }
  throw new Error("not a PNG or JPEG (pass width and height yourself)");
}
