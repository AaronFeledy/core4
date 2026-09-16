import { Effect, Stream } from "effect";

import { ArchiveFormatError } from "@lando/sdk/errors";

export type ArchiveStreamFormat = "tar" | "tar.gz" | "tar.zst";

const blockSize = 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const archiveError = (format: ArchiveStreamFormat, path: string, message: string, cause?: unknown) =>
  new ArchiveFormatError({
    message,
    format,
    archivePath: path,
    ...(cause === undefined ? {} : { cause }),
    remediation: "Recreate the archive and retry the transfer.",
  });

const octal = (value: number, width: number, path: string): string => {
  const text = value.toString(8);
  if (text.length > width - 1)
    throw archiveError("tar", path, "Archive payload is too large for the tar header.");
  return text.padStart(width - 1, "0");
};

const writeAscii = (target: Uint8Array, offset: number, value: string, length: number): void => {
  target.set(encoder.encode(value).slice(0, length), offset);
};

const tarHeader = (size: number, path: string): Uint8Array => {
  const header = new Uint8Array(blockSize);
  writeAscii(header, 0, "payload", 100);
  writeAscii(header, 100, `${octal(0o644, 8, path)}\0`, 8);
  writeAscii(header, 108, `${octal(0, 8, path)}\0`, 8);
  writeAscii(header, 116, `${octal(0, 8, path)}\0`, 8);
  writeAscii(header, 124, `${octal(size, 12, path)}\0`, 12);
  writeAscii(header, 136, `${octal(0, 12, path)}\0`, 12);
  header.fill(0x20, 148, 156);
  writeAscii(header, 156, "0", 1);
  writeAscii(header, 257, "ustar", 6);
  writeAscii(header, 263, "00", 2);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeAscii(header, 148, `${octal(checksum, 7, path)}\0 `, 8);
  return header;
};

const compressionName = (format: Exclude<ArchiveStreamFormat, "tar">): "gzip" | "zstd" =>
  format === "tar.gz" ? "gzip" : "zstd";

const throughCompression = <E, R>(
  source: Stream.Stream<Uint8Array, E, R>,
  format: Exclude<ArchiveStreamFormat, "tar">,
  path: string,
): Stream.Stream<Uint8Array, E | ArchiveFormatError, R> =>
  Stream.unwrap(
    Stream.toReadableStreamEffect(source).pipe(
      Effect.map((readable) =>
        Stream.fromReadableStream({
          evaluate: () => readable.pipeThrough(new CompressionStream(compressionName(format))),
          onError: (cause) => archiveError(format, path, "Failed to encode host archive endpoint.", cause),
          releaseLockOnEnd: true,
        }),
      ),
    ),
  );

const throughDecompression = <E, R>(
  source: Stream.Stream<Uint8Array, E, R>,
  format: Exclude<ArchiveStreamFormat, "tar">,
  path: string,
): Stream.Stream<Uint8Array, E | ArchiveFormatError, R> =>
  Stream.unwrap(
    Stream.toReadableStreamEffect(source).pipe(
      Effect.map((readable) =>
        Stream.fromReadableStream({
          evaluate: () => readable.pipeThrough(new DecompressionStream(compressionName(format))),
          onError: (cause) => archiveError(format, path, "Failed to decode host archive endpoint.", cause),
          releaseLockOnEnd: true,
        }),
      ),
    ),
  );

export const encodeArchiveStream = <E, R>(input: {
  readonly body: Stream.Stream<Uint8Array, E, R>;
  readonly sizeBytes: number;
  readonly format: ArchiveStreamFormat;
  readonly path: string;
}): Stream.Stream<Uint8Array, E | ArchiveFormatError, R> => {
  const padding = (blockSize - (input.sizeBytes % blockSize)) % blockSize;
  const tar = Stream.concat(
    Stream.make(tarHeader(input.sizeBytes, input.path)),
    Stream.concat(input.body, Stream.make(new Uint8Array(padding + blockSize * 2))),
  );
  return input.format === "tar" ? tar : throughCompression(tar, input.format, input.path);
};

const append = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  if (left.byteLength === 0) return right;
  const output = new Uint8Array(left.byteLength + right.byteLength);
  output.set(left);
  output.set(right, left.byteLength);
  return output;
};

const tarPayload = async function* (
  source: AsyncIterable<Uint8Array>,
  format: ArchiveStreamFormat,
  path: string,
  maxPayloadBytes: number,
): AsyncGenerator<Uint8Array> {
  let buffered: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let remaining: number | undefined;
  for await (const chunk of source) {
    buffered = append(buffered, chunk);
    if (remaining === undefined) {
      if (buffered.byteLength < blockSize) continue;
      const raw = decoder.decode(buffered.subarray(124, 136)).replaceAll("\0", "").trim();
      remaining = raw.length === 0 ? 0 : Number.parseInt(raw, 8);
      if (!Number.isSafeInteger(remaining) || remaining < 0) {
        throw archiveError(format, path, "Archive payload size is not a valid tar octal value.");
      }
      if (remaining > maxPayloadBytes) {
        throw archiveError(format, path, `Archive payload size exceeded ${maxPayloadBytes} bytes.`);
      }
      buffered = buffered.subarray(blockSize);
      if (remaining === 0) return;
    }
    if (remaining > 0 && buffered.byteLength > 0) {
      const count = Math.min(remaining, buffered.byteLength);
      yield buffered.subarray(0, count);
      buffered = buffered.subarray(count);
      remaining -= count;
      if (remaining === 0) return;
    }
  }
  if (remaining === undefined)
    throw archiveError(format, path, "Archive is too small to contain a tar header.");
  if (remaining !== 0) throw archiveError(format, path, "Archive payload is truncated.");
};

export const decodeArchiveStream = <E, R>(input: {
  readonly body: Stream.Stream<Uint8Array, E, R>;
  readonly format: ArchiveStreamFormat;
  readonly path: string;
  readonly maxPayloadBytes: number;
}): Stream.Stream<Uint8Array, E | ArchiveFormatError, R> => {
  const decoded =
    input.format === "tar" ? input.body : throughDecompression(input.body, input.format, input.path);
  return Stream.unwrap(
    Stream.toAsyncIterableEffect(decoded).pipe(
      Effect.map((source) =>
        Stream.fromAsyncIterable(
          tarPayload(source, input.format, input.path, input.maxPayloadBytes),
          (cause) =>
            cause instanceof ArchiveFormatError
              ? cause
              : archiveError(input.format, input.path, "Failed to decode host archive endpoint.", cause),
        ),
      ),
    ),
  );
};
