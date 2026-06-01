const textDecoder = new TextDecoder();

export type StreamBytes = Uint8Array<ArrayBufferLike>;
export type MultiplexedStream = "stdout" | "stderr";

export interface MultiplexedFrame {
  readonly stream: MultiplexedStream;
  readonly payload: StreamBytes;
}

export interface LogDecoderOptions<T> {
  readonly parseLine: (stream: MultiplexedStream, line: string) => T;
}

type LogsDecoderMode = "unknown" | "framed" | "raw";

const concatBytes = (left: StreamBytes, right: StreamBytes): StreamBytes => {
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left);
  merged.set(right, left.length);
  return merged;
};

const frameLength = (buffer: StreamBytes): number =>
  ((((buffer[4] ?? 0) << 24) |
    ((buffer[5] ?? 0) << 16) |
    ((buffer[6] ?? 0) << 8) |
    (buffer[7] ?? 0)) >>>
  0);

const streamName = (streamType: number): MultiplexedStream | undefined => {
  if (streamType === 1) return "stdout";
  if (streamType === 2) return "stderr";
  return undefined;
};

export const makeAttachDecoder = () => {
  let buffer: StreamBytes = new Uint8Array(0);

  return (chunk: StreamBytes): ReadonlyArray<MultiplexedFrame> => {
    buffer = concatBytes(buffer, chunk);

    const decoded: MultiplexedFrame[] = [];
    while (buffer.length >= 8) {
      const payloadLength = frameLength(buffer);
      if (buffer.length < 8 + payloadLength) break;

      const stream = streamName(buffer[0] ?? 0);
      const payload = buffer.slice(8, 8 + payloadLength);
      buffer = buffer.slice(8 + payloadLength);

      if (stream !== undefined) decoded.push({ stream, payload });
    }

    return decoded;
  };
};

const parseTextLines = <T>(
  parseLine: (stream: MultiplexedStream, line: string) => T,
  stream: MultiplexedStream,
  text: string,
): { readonly chunks: ReadonlyArray<T>; readonly remainder: string } => {
  const lines = text.split(/\r?\n/u);
  const remainder = lines.pop() ?? "";
  return {
    chunks: lines.filter((line) => line.length > 0).map((line) => parseLine(stream, line)),
    remainder,
  };
};

export const makeLogDecoder = <T>(options: LogDecoderOptions<T>) => {
  const decodeFrame = makeAttachDecoder();
  let mode: LogsDecoderMode = "unknown";
  let rawBuffer = "";

  const decodeRaw = (bytes: StreamBytes): ReadonlyArray<T> => {
    mode = "raw";
    const parsed = parseTextLines(options.parseLine, "stdout", rawBuffer + textDecoder.decode(bytes));
    rawBuffer = parsed.remainder;
    return parsed.chunks;
  };

  return (chunk: StreamBytes): ReadonlyArray<T> => {
    if (mode === "raw") return decodeRaw(chunk);
    if (chunk.length === 0) return [];
    if (mode === "unknown" && chunk[0] !== 1 && chunk[0] !== 2) return decodeRaw(chunk);

    mode = "framed";
    const decoded: T[] = [];
    for (const frame of decodeFrame(chunk)) {
      for (const line of textDecoder
        .decode(frame.payload)
        .split(/\r?\n/u)
        .filter((entry) => entry.length > 0)) {
        decoded.push(options.parseLine(frame.stream, line));
      }
    }
    return decoded;
  };
};
