// Synthetic constant-coefficient JPEGs; no external files or user data.
export function minimalJPEG(width: number, height: number, components = 3, progressive = false, adobe = false): Buffer {
  const marker = (code: number, data: number[]) => Buffer.from([0xff, code, (data.length + 2) >> 8, (data.length + 2) & 255, ...data]);
  const frame = [8, height >> 8, height & 255, width >> 8, width & 255, components];
  const scan = [components];
  for (let id = 1; id <= components; id++) { frame.push(id, 0x11, 0); scan.push(id, 0); }
  scan.push(0, progressive ? 0 : 63, 0);
  // One DC code (category 0), one AC code (EOB). All image coefficients are zero.
  const table = [1, ...Array<number>(15).fill(0), 0];
  const blocks = Math.ceil(width / 8) * Math.ceil(height / 8) * components;
  const bits = blocks * (progressive ? 1 : 2);
  const entropy = Buffer.alloc(Math.ceil(bits / 8));
  if (bits % 8) entropy[entropy.length - 1] = (1 << (8 - bits % 8)) - 1;
  return Buffer.concat([Buffer.from([0xff, 0xd8]),
    ...(adobe ? [marker(0xee, [65, 100, 111, 98, 101, 0, 100, 0, 0, 0, 0, 0])] : []),
    marker(0xdb, [0, ...Array<number>(64).fill(1)]),
    marker(0xc4, [0, ...table, 0x10, ...table]),
    marker(progressive ? 0xc2 : 0xc0, frame), marker(0xda, scan), entropy, Buffer.from([0xff, 0xd9])]);
}
