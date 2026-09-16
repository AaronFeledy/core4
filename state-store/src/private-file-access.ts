import { win32 } from "node:path";
import { Context, Effect, Layer } from "effect";
import {
  type PrivateFileAccessSpawn,
  bunPrivateFileAccessSpawn,
  makePrivateFileAccessWorker,
} from "./private-file-worker.ts";

export type OwnerOnlyFileAccess = (path: string) => Promise<void>;

export interface PrivateFileAccess {
  readonly enforce: OwnerOnlyFileAccess;
  readonly verify: OwnerOnlyFileAccess;
}

export interface PrivateFileAccessLiveOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly spawn?: PrivateFileAccessSpawn;
}

export class PrivateFileAccessError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`Failed to verify private file access: ${path}`);
    this.name = "PrivateFileAccessError";
    this.path = path;
  }
}

export class PrivateFileAccessService extends Context.Tag("@lando/state-store/PrivateFileAccess")<
  PrivateFileAccessService,
  PrivateFileAccess
>() {}

type ClosablePrivateFileAccess = PrivateFileAccess & { readonly close: () => Promise<void> };

export const makePrivateFileAccessLive = (
  options: PrivateFileAccessLiveOptions = {},
): Layer.Layer<PrivateFileAccessService> =>
  Layer.scoped(
    PrivateFileAccessService,
    Effect.acquireRelease(
      Effect.sync((): ClosablePrivateFileAccess => {
        const platform = options.platform ?? process.platform;
        if (platform !== "win32") {
          return {
            enforce: async () => undefined,
            verify: async () => undefined,
            close: async () => undefined,
          };
        }
        const env = options.env ?? process.env;
        const systemRoot = env.SystemRoot ?? env.WINDIR;
        if (systemRoot === undefined || !win32.isAbsolute(systemRoot)) {
          return {
            enforce: async (path: string) => {
              throw new PrivateFileAccessError(path);
            },
            verify: async (path: string) => {
              throw new PrivateFileAccessError(path);
            },
            close: async () => undefined,
          };
        }
        const worker = makePrivateFileAccessWorker({
          systemRoot,
          env,
          spawn: options.spawn ?? bunPrivateFileAccessSpawn,
        });
        return {
          enforce: async (path: string) => {
            try {
              await worker.enforce(path);
            } catch {
              throw new PrivateFileAccessError(path);
            }
          },
          verify: async (path: string) => {
            try {
              await worker.verify(path);
            } catch {
              throw new PrivateFileAccessError(path);
            }
          },
          close: worker.close,
        };
      }),
      (service) => Effect.promise(() => service.close()),
    ),
  );

export const PrivateFileAccessLive = makePrivateFileAccessLive();
