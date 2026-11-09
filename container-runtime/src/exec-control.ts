/** Private wire contract shared with the static Go exec-run helper. */
export const execDataFrames = function* (bytes: Uint8Array): Generator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += 65_536) {
    const payload = bytes.subarray(offset, offset + 65_536);
    const frame = new Uint8Array(5 + payload.length);
    new DataView(frame.buffer).setUint32(1, payload.length);
    frame.set(payload, 5);
    yield frame;
  }
};

export const execEofFrame = (): Uint8Array => new Uint8Array([1, 0, 0, 0, 0]);
export const execSignalFrame = (signal: AbortSignal | undefined): Uint8Array =>
  new Uint8Array([2, 0, 0, 0, 1, signal?.reason === "SIGINT" ? 2 : 15]);
