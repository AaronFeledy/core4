import { type FSWatcher, watch } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { basename, dirname } from "node:path";

import { Context, Data, Effect, Layer, Queue, type Scope } from "effect";

import type { AbsolutePath } from "@lando/sdk/schema";

const MAX_PAGE_BYTES = 64 * 1024;

export type TranscriptTailPageDirection = "latest" | "older" | "newer" | "refresh";

export interface TranscriptTailPage {
  readonly lines: ReadonlyArray<string>;
}

export interface TranscriptTailSession {
  readonly read: (
    direction: TranscriptTailPageDirection,
    lineLimit: number,
  ) => Effect.Effect<TranscriptTailPage, TranscriptTailReadError>;
}

export interface TranscriptTailReaderShape {
  readonly open: (
    path: AbsolutePath,
    onChange: Effect.Effect<void>,
  ) => Effect.Effect<TranscriptTailSession, TranscriptTailReadError, Scope.Scope>;
}

export class TranscriptTailReadError extends Data.TaggedError("TranscriptTailReadError")<{
  readonly path: AbsolutePath;
  readonly cause: unknown;
}> {}

class InvalidTranscriptFileError extends Error {
  override readonly name = "InvalidTranscriptFileError";
  constructor(readonly path: AbsolutePath) {
    super(`Transcript path is not a stable regular file: ${path}`);
  }
}

export class TranscriptTailReader extends Context.Tag("@lando/renderer-lando/TranscriptTailReader")<
  TranscriptTailReader,
  TranscriptTailReaderShape
>() {}

type FileIdentity = {
  readonly key: string;
  readonly size: number;
};

type Cursor = {
  readonly identity: string;
  readonly start: number;
  readonly end: number;
  readonly atLatest: boolean;
  readonly page: TranscriptTailPage;
};

const safeUtf8End = (bytes: Uint8Array): number => {
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

const lineRanges = (bytes: Uint8Array): ReadonlyArray<readonly [number, number]> => {
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

const decodeRanges = (
  bytes: Uint8Array,
  ranges: ReadonlyArray<readonly [number, number]>,
): ReadonlyArray<string> => {
  const decoder = new TextDecoder();
  return ranges.map(([start, end]) => decoder.decode(bytes.subarray(start, end)));
};

const readBytes = (handle: FileHandle, position: number, length: number) =>
  Effect.tryPromise({
    try: async () => {
      const buffer = new Uint8Array(length);
      const result = await handle.read(buffer, 0, length, position);
      return buffer.subarray(0, result.bytesRead);
    },
    catch: (cause) => cause,
  });

const identityOf = (handle: FileHandle) =>
  Effect.tryPromise({
    try: async (): Promise<FileIdentity> => {
      const stats = await handle.stat();
      return { key: `${stats.dev}:${stats.ino}`, size: stats.size };
    },
    catch: (cause) => cause,
  });

const readEndingAt = (handle: FileHandle, identity: FileIdentity, end: number, lineLimit: number) =>
  Effect.gen(function* () {
    const readStart = Math.max(0, end - MAX_PAGE_BYTES);
    const raw = yield* readBytes(handle, readStart, end - readStart);
    const firstNewline = readStart === 0 ? -1 : raw.indexOf(0x0a);
    const prefix = readStart === 0 ? 0 : firstNewline < 0 ? raw.length : firstNewline + 1;
    const safe = raw.subarray(prefix, safeUtf8End(raw));
    const ranges = lineRanges(safe);
    const selected = lineLimit === 0 ? [] : ranges.slice(-lineLimit);
    const selectedStart = selected[0]?.[0] ?? safe.length;
    return {
      identity: identity.key,
      start: selected.length === 0 ? readStart : readStart + prefix + selectedStart,
      end,
      atLatest: end === identity.size,
      page: { lines: decodeRanges(safe, selected) },
    } satisfies Cursor;
  });

const readStartingAt = (handle: FileHandle, identity: FileIdentity, start: number, lineLimit: number) =>
  Effect.gen(function* () {
    const readEnd = Math.min(identity.size, start + MAX_PAGE_BYTES);
    const raw = yield* readBytes(handle, start, readEnd - start);
    const safeEnd = safeUtf8End(raw);
    const bounded = raw.subarray(0, safeEnd);
    const ranges = lineRanges(bounded);
    const completeRanges =
      readEnd === identity.size ? ranges : ranges.filter(([, end]) => end < bounded.length);
    const selected = lineLimit === 0 ? [] : completeRanges.slice(0, lineLimit);
    const last = selected.at(-1);
    let selectedEnd = last?.[1] ?? 0;
    while (bounded[selectedEnd] === 0x0d || bounded[selectedEnd] === 0x0a) selectedEnd += 1;
    const end = last === undefined ? start : start + selectedEnd;
    return {
      identity: identity.key,
      start,
      end: Math.min(end, identity.size),
      atLatest: end >= identity.size,
      page: { lines: decodeRanges(bounded, selected) },
    } satisfies Cursor;
  });

const makeSession = (path: AbsolutePath): TranscriptTailSession => {
  let cursor: Cursor | undefined;
  const read = (direction: TranscriptTailPageDirection, lineLimit: number) =>
    Effect.acquireUseRelease(
      Effect.tryPromise({
        try: async () => {
          const before = await lstat(path);
          if (!before.isFile() || before.isSymbolicLink()) throw new InvalidTranscriptFileError(path);
          const handle = await open(path, "r");
          const after = await handle.stat();
          if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino) {
            await handle.close();
            throw new InvalidTranscriptFileError(path);
          }
          return handle;
        },
        catch: (cause) => cause,
      }),
      (handle) =>
        Effect.gen(function* () {
          const identity = yield* identityOf(handle);
          if (
            cursor === undefined ||
            cursor.identity !== identity.key ||
            identity.size < cursor.end ||
            direction === "latest"
          ) {
            return yield* readEndingAt(handle, identity, identity.size, lineLimit);
          }
          const current = cursor;
          if (direction === "refresh") {
            return yield* readEndingAt(
              handle,
              identity,
              current.atLatest ? identity.size : current.end,
              lineLimit,
            );
          }
          if (direction === "older") {
            if (current.start === 0) return current;
            return yield* readEndingAt(handle, identity, current.start, lineLimit);
          }
          if (current.end >= identity.size) return current;
          return yield* readStartingAt(handle, identity, current.end, lineLimit);
        }),
      (handle) => Effect.promise(() => handle.close()),
    ).pipe(
      Effect.tap((next: Cursor) =>
        Effect.sync(() => {
          cursor = next;
        }),
      ),
      Effect.map((next) => next.page),
      Effect.mapError((cause) => new TranscriptTailReadError({ path, cause })),
    );
  return { read };
};

const openReader = (path: AbsolutePath, onChange: Effect.Effect<void>) =>
  Effect.gen(function* () {
    const notifications = yield* Queue.dropping<void>(1);
    yield* Effect.acquireRelease(
      Effect.try({
        try: (): FSWatcher => {
          const watcher = watch(dirname(path), (_eventType, filename) => {
            if (filename === null || basename(filename.toString()) === basename(path)) {
              Effect.runSync(Queue.offer(notifications, undefined));
            }
          });
          watcher.on("error", () => Effect.runSync(Queue.offer(notifications, undefined)));
          return watcher;
        },
        catch: (cause) => new TranscriptTailReadError({ path, cause }),
      }),
      (watcher) => Effect.sync(() => watcher.close()),
    );
    yield* Effect.forkScoped(Effect.forever(Queue.take(notifications).pipe(Effect.zipRight(onChange))));
    return makeSession(path);
  });

export const TranscriptTailReaderLive = Layer.succeed(TranscriptTailReader, { open: openReader });
