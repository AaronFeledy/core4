import { lstat, readdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  verifyHostProxyContainerDirectory,
  verifyHostProxyRunDirectory,
} from "@lando/engine/subsystems/host-proxy/run-directory";
import { Context, Effect, Layer } from "effect";

export type HostProxyDoctorRootState =
  | { readonly _tag: "absent" }
  | { readonly _tag: "unreadable"; readonly errorCode: string }
  | {
      readonly _tag: "entries";
      readonly entries: ReadonlyArray<{ readonly name: string; readonly isDirectory: boolean }>;
    };

export interface HostProxyDoctorFileSystemShape {
  readonly readRoot: (path: string) => Effect.Effect<HostProxyDoctorRootState>;
  readonly socketMetadata: (path: string) => Effect.Effect<
    | {
        readonly type: "socket" | "directory" | "other";
        readonly mode: number;
        readonly owned: boolean;
      }
    | undefined
  >;
  /** Whether the directory holding the socket passes the engine's rule for that record layout. */
  readonly socketDirectoryPrivate: (
    socketPath: string,
    layout: "container" | "run-directory",
  ) => Effect.Effect<boolean>;
}

export class HostProxyDoctorFileSystem extends Context.Service<
  HostProxyDoctorFileSystem,
  HostProxyDoctorFileSystemShape
>()("@lando/core/HostProxyDoctorFileSystem") {
  static readonly layer = Layer.succeed(
    this,
    this.of({
      readRoot: Effect.fn("HostProxyDoctorFileSystem.readRoot")((path: string) =>
        Effect.promise(async () => {
          try {
            const entries = await readdir(path, { withFileTypes: true });
            return {
              _tag: "entries",
              entries: entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() })),
            } as const;
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            const code = "code" in error && typeof error.code === "string" ? error.code : "UNKNOWN";
            return code === "ENOENT"
              ? ({ _tag: "absent" } as const)
              : ({ _tag: "unreadable", errorCode: code } as const);
          }
        }),
      ),
      socketMetadata: Effect.fn("HostProxyDoctorFileSystem.socketMetadata")((path: string) =>
        Effect.promise(async () => {
          try {
            const metadata = await lstat(path);
            return {
              type: metadata.isSocket() ? "socket" : metadata.isDirectory() ? "directory" : "other",
              mode: metadata.mode & 0o777,
              owned: metadata.uid === process.getuid?.(),
            } as const;
          } catch (error) {
            if (error instanceof Error) return undefined;
            throw error;
          }
        }),
      ),
      socketDirectoryPrivate: Effect.fn("HostProxyDoctorFileSystem.socketDirectoryPrivate")(
        (socketPath, layout) =>
          Effect.promise(() => {
            const directory = dirname(socketPath);
            const verify =
              layout === "container" ? verifyHostProxyContainerDirectory : verifyHostProxyRunDirectory;
            return verify(directory).then(
              () => true,
              () => false,
            );
          }),
      ),
    }),
  );
}
