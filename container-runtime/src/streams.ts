import { makeLineFramer } from "@lando/sdk/log-follow";
import { DateTime, Option, Stream } from "effect";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

export type StreamBytes = Uint8Array<ArrayBufferLike>;
export type MultiplexedStream = "stdout" | "stderr";

export interface MultiplexedFrame {
  readonly stream: MultiplexedStream;
  readonly payload: StreamBytes;
}

export interface DecodedLogLine {
  readonly stream: MultiplexedStream;
  readonly line: string;
  readonly timestamp?: Date;
}

type LogsDecoderMode = "unknown" | "framed" | "raw";

const concatBytes = (left: StreamBytes, right: StreamBytes): StreamBytes => {
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left);
  merged.set(right, left.length);
  return merged;
};

const frameLength = (buffer: StreamBytes): number =>
  (((buffer[4] ?? 0) << 24) | ((buffer[5] ?? 0) << 16) | ((buffer[6] ?? 0) << 8) | (buffer[7] ?? 0)) >>> 0;

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

const timestampedPayload = (
  payload: StreamBytes,
): { readonly content: StreamBytes; readonly timestamp?: Date } => {
  const separator = payload.subarray(0, 64).indexOf(0x20);
  if (separator < 0) return { content: payload };
  const prefix = payload.subarray(0, separator);
  if (prefix.some((byte) => byte > 0x7f)) return { content: payload };
  const text = textDecoder.decode(prefix);
  if (!/^\d{4}-\d{2}-\d{2}T\S+$/u.test(text)) return { content: payload };
  const parsed = DateTime.make(text);
  return Option.isNone(parsed)
    ? { content: payload }
    : { content: payload.subarray(separator + 1), timestamp: DateTime.toDate(parsed.value) };
};

export const makeLogDecoder = () => {
  let decodeFrame = makeAttachDecoder();
  let mode: LogsDecoderMode = "unknown";
  const framers = { stdout: makeLineFramer(), stderr: makeLineFramer() };
  const raw = makeLineFramer();
  // Map insertion order records the arrival of each pending line's first segment.
  const pending = new Map<MultiplexedStream, Date | undefined>();
  const rawLine = (line: string): DecodedLogLine => {
    // TTY logs lack frame boundaries, so continuation timestamps are unrecoverable.
    const { content, timestamp } = timestampedPayload(textEncoder.encode(line));
    return {
      stream: "stdout",
      line: textDecoder.decode(content),
      ...(timestamp === undefined ? {} : { timestamp }),
    };
  };

  const feed = (chunk: StreamBytes): ReadonlyArray<DecodedLogLine> => {
    if (chunk.length === 0) return [];
    if (mode === "unknown") mode = chunk[0] === 1 || chunk[0] === 2 ? "framed" : "raw";
    if (mode === "raw") return raw.feed(chunk).map(({ text }) => rawLine(text));

    const decoded: DecodedLogLine[] = [];
    for (const { stream, payload } of decodeFrame(chunk)) {
      const { content, timestamp } = timestampedPayload(payload);
      if (content.length === 0) continue;
      if (!pending.has(stream)) pending.set(stream, timestamp);
      const lines = framers[stream].feed(content);
      for (const [index, { text }] of lines.entries()) {
        const startedAt = index === 0 ? pending.get(stream) : timestamp;
        decoded.push({ stream, line: text, ...(startedAt === undefined ? {} : { timestamp: startedAt }) });
      }
      if (lines.length > 0) {
        pending.delete(stream);
        if (content[content.length - 1] !== 0x0a) pending.set(stream, timestamp);
      }
    }
    return decoded;
  };

  const flush = (): ReadonlyArray<DecodedLogLine> => {
    const decoded: DecodedLogLine[] = [];
    for (const [stream, timestamp] of pending) {
      for (const { text } of framers[stream].flush()) {
        decoded.push({ stream, line: text, ...(timestamp === undefined ? {} : { timestamp }) });
      }
    }
    decoded.push(...raw.flush().map(({ text }) => rawLine(text)));
    pending.clear();
    decodeFrame = makeAttachDecoder();
    mode = "unknown";
    return decoded;
  };
  return { feed, flush };
};

export const decodeLogStream = <E, R>(
  bytes: Stream.Stream<StreamBytes, E, R>,
): Stream.Stream<DecodedLogLine, E, R> =>
  Stream.suspend(() => {
    const decoder = makeLogDecoder();
    const decoded = bytes.pipe(Stream.flatMap((chunk) => Stream.fromIterable(decoder.feed(chunk))));
    return Stream.concat(
      decoded,
      Stream.suspend(() => Stream.fromIterable(decoder.flush())),
    );
  });
