declare function decode(data: Uint8Array, options: {
  useTArray: boolean;
  formatAsRGBA: boolean;
  tolerantDecoding: boolean;
  validateOversizedProfile: boolean;
  maxMemoryUsageInMB?: number;
}): { width: number; height: number };
export = decode;
