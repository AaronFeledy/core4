export const safeUtf8End = (bytes: Uint8Array): number => {
  let continuationCount = 0;
  for (let index = bytes.length - 1; index >= 0 && continuationCount < 3; index -= 1) {
    const byte = bytes[index];
    if (byte === undefined) return bytes.length;
    if ((byte & 0xc0) === 0x80) {
      continuationCount += 1;
      continue;
    }
    const expected = byte < 0x80 ? 0 : byte < 0xe0 ? 1 : byte < 0xf0 ? 2 : byte < 0xf8 ? 3 : 0;
    return continuationCount < expected ? index : bytes.length;
  }
  return continuationCount === 0 ? bytes.length : bytes.length - continuationCount;
};

export const lineRanges = (bytes: Uint8Array): ReadonlyArray<readonly [number, number]> => {
  const ranges: Array<readonly [number, number]> = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    const end = index > start && bytes[index - 1] === 0x0d ? index - 1 : index;
    ranges.push([start, end]);
    start = index + 1;
  }
  if (start < bytes.length) ranges.push([start, bytes.length]);
  return ranges;
};

export const decodeRanges = (
  bytes: Uint8Array,
  ranges: ReadonlyArray<readonly [number, number]>,
): ReadonlyArray<string> => {
  const decoder = new TextDecoder();
  return ranges.map(([start, end]) => decoder.decode(bytes.subarray(start, end)));
};
