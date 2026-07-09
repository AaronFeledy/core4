/**
 * In-memory {@link LogFileAccess} seam for deterministic follower tests and the
 * SDK fake provider. It models device/inode identity, appends, rename+create
 * rotation, copytruncate, and removal, and tracks live open-handle count so
 * lifecycle/reaping assertions can prove every follower handle is released at
 * scope close.
 */
import { Effect, Option } from "effect";

import type { LogFileAccess, LogFileHandle, LogFileStat } from "./index.ts";

const encoder = new TextEncoder();

const toBytes = (content: string | Uint8Array): Uint8Array =>
  typeof content === "string" ? encoder.encode(content) : content;

const concat = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left);
  merged.set(right, left.length);
  return merged;
};

interface MemoryFile {
  ino: string;
  bytes: Uint8Array;
}

export interface MemoryLogFileAccess {
  readonly access: LogFileAccess;
  /** Create or overwrite a file (fresh inode). */
  readonly writeFile: (path: string, content: string | Uint8Array) => void;
  /** Append to an existing file (same inode); creates it if absent. */
  readonly appendFile: (path: string, content: string | Uint8Array) => void;
  /** logrotate rename+create: new inode replaces the old file at `path`. */
  readonly rotateRenameCreate: (path: string, content: string | Uint8Array) => void;
  /** logrotate copytruncate: same inode, truncated to the new content. */
  readonly copyTruncate: (path: string, content: string | Uint8Array) => void;
  /** Remove a file entirely (stat resolves `Option.none()`). */
  readonly removeFile: (path: string) => void;
  /** Number of currently-open handles (0 after all followers are reaped). */
  readonly openHandleCount: () => number;
}

export const makeMemoryLogFileAccess = (dev = "memfs"): MemoryLogFileAccess => {
  const files = new Map<string, MemoryFile>();
  let nextIno = 1;
  let openHandles = 0;

  const allocIno = (): string => {
    const ino = `ino-${nextIno}`;
    nextIno += 1;
    return ino;
  };

  const statOf = (file: MemoryFile): LogFileStat => ({
    dev,
    ino: file.ino,
    size: BigInt(file.bytes.length),
  });

  const access: LogFileAccess = {
    stat: (path) =>
      Effect.sync(() => {
        const file = files.get(path);
        return file === undefined ? Option.none<LogFileStat>() : Option.some(statOf(file));
      }),
    open: (path) =>
      Effect.sync((): LogFileHandle => {
        const file = files.get(path) ?? { ino: allocIno(), bytes: new Uint8Array(0) };
        const boundIno = file.ino;
        let closed = false;
        openHandles += 1;
        // Read from the inode bound at open so a rename+create rotation drains
        // the old inode from this handle even after `path` points at a new file.
        return {
          stat: Effect.sync(() => {
            const current = files.get(path);
            if (current !== undefined && current.ino === boundIno) return statOf(current);
            return { dev, ino: boundIno, size: BigInt(file.bytes.length) };
          }),
          read: (offset, maxBytes) =>
            Effect.sync(() => {
              const current = files.get(path);
              const bytes = current !== undefined && current.ino === boundIno ? current.bytes : file.bytes;
              const start = Number(offset);
              if (start >= bytes.length) {
                return { bytes: new Uint8Array(0), nextOffset: BigInt(bytes.length), eof: true };
              }
              const end = Math.min(bytes.length, start + maxBytes);
              return { bytes: bytes.slice(start, end), nextOffset: BigInt(end), eof: end >= bytes.length };
            }),
          close: Effect.sync(() => {
            if (closed) return;
            closed = true;
            openHandles -= 1;
          }),
        };
      }),
  };

  return {
    access,
    writeFile: (path, content) => {
      files.set(path, { ino: allocIno(), bytes: toBytes(content) });
    },
    appendFile: (path, content) => {
      const existing = files.get(path);
      if (existing === undefined) {
        files.set(path, { ino: allocIno(), bytes: toBytes(content) });
        return;
      }
      existing.bytes = concat(existing.bytes, toBytes(content));
    },
    rotateRenameCreate: (path, content) => {
      files.set(path, { ino: allocIno(), bytes: toBytes(content) });
    },
    copyTruncate: (path, content) => {
      const existing = files.get(path);
      if (existing === undefined) {
        files.set(path, { ino: allocIno(), bytes: toBytes(content) });
        return;
      }
      existing.bytes = toBytes(content);
    },
    removeFile: (path) => {
      files.delete(path);
    },
    openHandleCount: () => openHandles,
  };
};
