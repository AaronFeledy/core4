import { watch } from "node:fs";
import { mkdtemp, open, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer } from "effect";

export const INOTIFY_LIMITS = ["max_user_watches", "max_user_instances", "max_queued_events"] as const;
export type InotifyLimit = (typeof INOTIFY_LIMITS)[number];
export type WatchAllocation =
  | { readonly stage: "complete" }
  | { readonly stage: "setup" | "watch" | "cleanup"; readonly errno: string };
export interface WatchObservation {
  readonly limits: Readonly<Record<InotifyLimit, string>>;
  readonly allocation: WatchAllocation;
  readonly cleanup: string;
}

/** Narrow native boundary; overrides let tests exercise resource ownership without exhaustion. */
export interface WatchNativeIO {
  readonly readLimit: (name: InotifyLimit) => Promise<string>;
  readonly makeDirectory: () => Promise<string>;
  readonly watchDirectory: (
    path: string,
    onError: (error: unknown) => void,
  ) => { readonly close: () => void };
  readonly removeDirectory: (path: string) => Promise<void>;
}

const errno = (error: unknown): string => {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : "UNKNOWN";
  }
  return "UNKNOWN";
};

export const nativeWatchIO = {
  readLimit: async (name) => {
    const file = await open(`/proc/sys/fs/inotify/${name}`, "r");
    try {
      const buffer = Buffer.alloc(64);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const text = buffer.subarray(0, bytesRead).toString().trim();
      return bytesRead < buffer.length && /^\d+$/.test(text) && Number.isSafeInteger(Number(text))
        ? text
        : "unavailable:invalid-value";
    } finally {
      await file.close();
    }
  },
  makeDirectory: () => mkdtemp(join(tmpdir(), "lando-doctor-watch-")),
  watchDirectory: (path, onError) =>
    watch(path, { recursive: false, persistent: false }, () => {}).on("error", onError),
  removeDirectory: (path) => rmdir(path),
} satisfies WatchNativeIO;

const observe = (io: WatchNativeIO) =>
  Effect.promise(async (signal): Promise<WatchObservation> => {
    const limits: Record<InotifyLimit, string> = {
      max_user_watches: "unavailable",
      max_user_instances: "unavailable",
      max_queued_events: "unavailable",
    };
    for (const name of INOTIFY_LIMITS) {
      signal.throwIfAborted();
      try {
        limits[name] = await io.readLimit(name);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        const code = errno(error);
        limits[name] = `${code === "EACCES" || code === "EPERM" ? "restricted" : "unavailable"}:${code}`;
      }
    }
    let directory: string | undefined;
    let watcher: ReturnType<WatchNativeIO["watchDirectory"]> | undefined;
    let allocation: WatchAllocation = { stage: "complete" };
    let stage: "setup" | "watch" = "setup";
    let cleanup = "complete";
    // Native promises cannot be cancelled. This finally owns late acquisitions too:
    // cancellation returns promptly, but a late directory is removed, never watched.
    try {
      signal.throwIfAborted();
      directory = await io.makeDirectory();
      signal.throwIfAborted();
      stage = "watch";
      watcher = io.watchDirectory(directory, (error) => {
        allocation = { stage: "watch", errno: errno(error) };
      });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      allocation = { stage, errno: errno(error) };
    } finally {
      try {
        watcher?.close();
      } catch (error) {
        cleanup = `watch-close:${errno(error)}`;
      } finally {
        if (directory !== undefined) {
          try {
            await io.removeDirectory(directory);
          } catch (error) {
            cleanup = `${cleanup === "complete" ? "" : `${cleanup};`}directory-remove:${errno(error)}`;
          }
        }
      }
    }
    if (cleanup !== "complete" && allocation.stage === "complete") {
      allocation = { stage: "cleanup", errno: cleanup };
    }
    return { limits, allocation, cleanup };
  });

export class FilesystemWatchIO extends Context.Service<
  FilesystemWatchIO,
  { readonly observe: Effect.Effect<WatchObservation> }
>()("@lando/core/FilesystemWatchIO") {
  static readonly layerWith = (io: WatchNativeIO) => Layer.succeed(this, this.of({ observe: observe(io) }));
  static readonly layer = this.layerWith(nativeWatchIO);
}
