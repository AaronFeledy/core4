import { lstat, readdir } from "node:fs/promises";
import { dirname } from "node:path";

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
        readonly type: "socket" | "other";
        readonly mode: number;
        readonly owned: boolean;
        readonly privateDirectory: boolean;
      }
    | undefined
  >;
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
            const directory = await lstat(dirname(path));
            return {
              type: metadata.isSocket() ? "socket" : "other",
              mode: metadata.mode & 0o777,
              owned: metadata.uid === process.getuid?.(),
              privateDirectory:
                directory.isDirectory() &&
                !directory.isSymbolicLink() &&
                (directory.mode & 0o777) === 0o700 &&
                directory.uid === process.getuid?.(),
            } as const;
          } catch (error) {
            if (error instanceof Error) return undefined;
            throw error;
          }
        }),
      ),
    }),
  );
}
