import { type FSWatcher, watch } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { basename, dirname } from "node:path";

import { Context, Data, Effect, Layer, Option, Queue, type Scope } from "effect";

import type { AbsolutePath } from "@lando/sdk/schema";
import { PathsService } from "@lando/sdk/services";

import { TranscriptPathOutsideRootError, assertTranscriptPathContained } from "./transcript-path-boundary.ts";
import { decodeRanges, lineRanges, safeUtf8End } from "./transcript-tail-lines.ts";

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

const assertContained = (userDataRoot: string, path: AbsolutePath) =>
  Effect.tryPromise({
    try: () => assertTranscriptPathContained(userDataRoot, path),
    catch: (cause) => new TranscriptTailReadError({ path, cause }),
  });

const makeSession = (userDataRoot: string, path: AbsolutePath): TranscriptTailSession => {
  let cursor: Cursor | undefined;
  const read = (direction: TranscriptTailPageDirection, lineLimit: number) =>
    Effect.acquireUseRelease(
      Effect.tryPromise({
        try: async () => {
          await Effect.runPromise(assertContained(userDataRoot, path));
          const before = await lstat(path);
          if (!before.isFile() || before.isSymbolicLink()) throw new InvalidTranscriptFileError(path);
          const handle = await open(path, "r");
          const after = await handle.stat();
          if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino) {
            await handle.close();
            throw new InvalidTranscriptFileError(path);
          }
          await Effect.runPromise(assertContained(userDataRoot, path));
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

const openReader = (userDataRoot: string, path: AbsolutePath, onChange: Effect.Effect<void>) =>
  Effect.gen(function* () {
    yield* assertContained(userDataRoot, path);
    const notifications = yield* Queue.dropping<void>(1);
    yield* Effect.acquireRelease(
      Effect.try({
        try: (): FSWatcher => {
          const watcher = watch(dirname(path), (_eventType, filename) => {
            if (
              filename === null ||
              filename === undefined ||
              basename(filename.toString()) === basename(path)
            ) {
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
    return makeSession(userDataRoot, path);
  });

export const TranscriptTailReaderLive = Layer.effect(
  TranscriptTailReader,
  Effect.serviceOption(PathsService).pipe(
    Effect.map((paths) =>
      Option.isSome(paths)
        ? {
            open: (path: AbsolutePath, onChange: Effect.Effect<void>) =>
              openReader(paths.value.roots.userDataRoot, path, onChange),
          }
        : {
            open: (path: AbsolutePath) =>
              Effect.fail(
                new TranscriptTailReadError({
                  path,
                  cause: new TranscriptPathOutsideRootError(path),
                }),
              ),
          },
    ),
  ),
);
