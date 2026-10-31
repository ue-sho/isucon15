import decode from "./vendor/jpeg-js/decoder.cjs";
import { decodeJPEG, type JPEGImage } from "./jpeg.ts";

// Routing hint only: it never accepts or rejects a JPEG. Unusual/truncated marker
// layouts use the original decoder. Bound the extra scan independently of input size.
function hasOversizedProfileFrame(data: Uint8Array): boolean {
  if (data[0] !== 0xff || data[1] !== 0xd8) return false;
  let offset = 2;
  for (let segments = 0; segments < 64; segments++) {
    if (offset + 4 > data.length || data[offset] !== 0xff) return false;
    const marker = data[offset + 1];
    const length = (data[offset + 2] << 8) | data[offset + 3];
    if (length < 2 || offset + 2 + length > data.length) return false;
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (length < 8) return false;
      const height = (data[offset + 5] << 8) | data[offset + 6];
      const width = (data[offset + 7] << 8) | data[offset + 8];
      return width > 512 || height > 512;
    }
    if (!(marker >= 0xe0 && marker <= 0xef) && ![0xfe, 0xdb, 0xc4, 0xdd, 0xdc].includes(marker)) return false;
    offset += 2 + length;
  }
  return false;
}

// The profile handler rejects >512px images. Validate the complete stream first,
// retaining the old decoder's error checks, but do not render their RGB output.
export function validateProfileJPEG(data: Uint8Array): JPEGImage | null {
  // Keep the exact original decoder for normal-size images, including its JIT path.
  if (!hasOversizedProfileFrame(data)) return decodeJPEG(data);
  try {
    const image = decode(data, { useTArray: true, formatAsRGBA: false, tolerantDecoding: false, validateOversizedProfile: true });
    return { width: image.width, height: image.height };
  } catch {
    return null;
  }
}
