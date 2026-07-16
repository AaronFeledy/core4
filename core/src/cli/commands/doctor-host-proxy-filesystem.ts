import { lstat, readdir } from "node:fs/promises";

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
  readonly socketMetadata: (
    path: string,
  ) => Effect.Effect<{ readonly type: "socket" | "other"; readonly mode: number } | undefined>;
}

export class HostProxyDoctorFileSystem extends Context.Tag("@lando/core/HostProxyDoctorFileSystem")<
  HostProxyDoctorFileSystem,
  HostProxyDoctorFileSystemShape
>() {}

export const HostProxyDoctorFileSystemLive = Layer.succeed(HostProxyDoctorFileSystem, {
  readRoot: (path) =>
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
  socketMetadata: (path) =>
    Effect.promise(async () => {
      try {
        const metadata = await lstat(path);
        return { type: metadata.isSocket() ? "socket" : "other", mode: metadata.mode & 0o777 } as const;
      } catch (error) {
        if (error instanceof Error) return undefined;
        throw error;
      }
    }),
});
