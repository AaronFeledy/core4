import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { mkdtemp, open, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer } from "effect";

export const INOTIFY_LIMITS = ["max_user_watches", "max_user_instances", "max_queued_events"] as const;
export type InotifyLimit = (typeof INOTIFY_LIMITS)[number];
export type WatchAllocation =
  | { readonly stage: "complete" }
  | { readonly stage: "setup" | "watch" | "delivery" | "cleanup"; readonly errno: string };
export interface WatchObservation {
  readonly limits: Readonly<Partial<Record<InotifyLimit, string>>>;
  readonly allocation: WatchAllocation;
  readonly cleanup: string;
  readonly eventDelivery: "confirmed" | "missing" | "unobserved";
}

/** Narrow native boundary; overrides let tests exercise resource ownership without exhaustion. */
export interface WatchNativeIO {
  readonly readLimit: (name: InotifyLimit) => Promise<string>;
  readonly makeDirectory: () => Promise<string>;
  readonly watchDirectory: (
    path: string,
    onError: (error: unknown) => void,
    onEvent?: (filename: string | null) => void,
  ) => { readonly close: () => void };
  readonly removeDirectory: (path: string) => Promise<void>;
  readonly writeProbeFile?: (path: string) => Promise<void>;
  readonly removeProbeFile?: (path: string) => Promise<void>;
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
  watchDirectory: (
    path: string,
    onError: (error: unknown) => void,
    onEvent?: (filename: string | null) => void,
  ) =>
    watch(path, { recursive: false, persistent: false }, (_event, filename) => {
      onEvent?.(filename === null ? null : String(filename));
    }).on("error", onError),
  removeDirectory: (path) => rmdir(path),
  writeProbeFile: (path) => writeFile(path, "", { flag: "wx" }),
  removeProbeFile: (path) => unlink(path),
} satisfies WatchNativeIO;

const observe = (io: WatchNativeIO, platform: string) =>
  Effect.promise(async (signal): Promise<WatchObservation> => {
    const windows = platform === "win32";
    const limits: Partial<Record<InotifyLimit, string>> = {};
    if (!windows) {
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
    }
    let directory: string | undefined;
    let probeFile: string | undefined;
    let watcher: ReturnType<WatchNativeIO["watchDirectory"]> | undefined;
    let allocation: WatchAllocation = { stage: "complete" };
    let stage: "setup" | "watch" | "delivery" = "setup";
    let cleanup = "complete";
    const delivery: { status: WatchObservation["eventDelivery"] } = { status: "unobserved" };
    let wake = () => {};
    const event = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const marker = windows ? `lando-watch-${randomUUID()}` : "";
    const onAbort = () => wake();
    signal.addEventListener("abort", onAbort, { once: true });
    // Native promises cannot be cancelled. The finally block owns late acquisitions too:
    // cancellation returns promptly, but a late directory is removed, never watched.
    try {
      signal.throwIfAborted();
      directory = await io.makeDirectory();
      signal.throwIfAborted();
      stage = "watch";
      watcher = io.watchDirectory(
        directory,
        (error) => {
          allocation = { stage: "watch", errno: errno(error) };
          wake();
        },
        windows
          ? (filename) => {
              if (filename === marker) {
                delivery.status = "confirmed";
                wake();
              }
            }
          : undefined,
      );
      if (windows && allocation.stage === "complete") {
        stage = "delivery";
        probeFile = join(directory, marker);
        if (io.writeProbeFile === undefined || io.removeProbeFile === undefined) {
          allocation = { stage: "delivery", errno: "ENOSYS" };
        } else {
          await io.writeProbeFile(probeFile);
          signal.throwIfAborted();
          // The shorter event window reports missing delivery and completes cleanup.
          // runProbe still bounds hung native acquisition and writes.
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              event,
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, 750);
              }),
            ]);
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
          signal.throwIfAborted();
          if (allocation.stage === "complete" && delivery.status !== "confirmed") {
            delivery.status = "missing";
            allocation = { stage: "delivery", errno: "ETIMEDOUT" };
          }
        }
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      allocation = { stage, errno: errno(error) };
    } finally {
      signal.removeEventListener("abort", onAbort);
      try {
        watcher?.close();
      } catch (error) {
        cleanup = `watch-close:${errno(error)}`;
      }
      if (probeFile !== undefined && io.removeProbeFile !== undefined) {
        try {
          await io.removeProbeFile(probeFile);
        } catch (error) {
          if (errno(error) !== "ENOENT") {
            cleanup = `${cleanup === "complete" ? "" : `${cleanup};`}file-remove:${errno(error)}`;
          }
        }
      }
      if (directory !== undefined) {
        try {
          await io.removeDirectory(directory);
        } catch (error) {
          cleanup = `${cleanup === "complete" ? "" : `${cleanup};`}directory-remove:${errno(error)}`;
        }
      }
    }
    if (cleanup !== "complete" && allocation.stage === "complete") {
      allocation = { stage: "cleanup", errno: cleanup };
    }
    return { limits, allocation, cleanup, eventDelivery: delivery.status };
  });

export class FilesystemWatchIO extends Context.Service<
  FilesystemWatchIO,
  { readonly observe: Effect.Effect<WatchObservation> }
>()("@lando/core/FilesystemWatchIO") {
  static readonly layerWith = (io: WatchNativeIO, platform = "linux") =>
    Layer.succeed(this, this.of({ observe: observe(io, platform) }));
  static readonly layer = this.layerWith(nativeWatchIO, process.platform);
}
