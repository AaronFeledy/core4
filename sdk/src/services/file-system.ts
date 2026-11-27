import { Context, type Effect, type Stream } from "effect";

import type { FileIoError, FileNotFoundError, FilePermissionError } from "../errors/index.ts";

export type FileSystemError = FileNotFoundError | FilePermissionError | FileIoError;

export interface FileStat {
  readonly size: number;
  readonly mtimeMs: number;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink?: boolean;
  /** Owning user id where the host reports one (POSIX). */
  readonly uid?: number;
  /** Owning group id where the host reports one (POSIX). */
  readonly gid?: number;
  /** Permission and type bits where the host reports them (POSIX `st_mode`). */
  readonly mode?: number;
  /** Hard-link count where the host reports one (POSIX `st_nlink`). */
  readonly nlink?: number;
}

export class FileSystem extends Context.Service<
  FileSystem,
  {
    readonly read: (path: string) => Stream.Stream<Uint8Array, FileSystemError>;
    readonly readText: (path: string) => Effect.Effect<string, FileSystemError>;
    readonly write: (path: string, content: string | Uint8Array) => Effect.Effect<void, FileSystemError>;
    /** Append with `O_APPEND`, creating the file (not its parents) when missing. */
    readonly append: (path: string, content: string | Uint8Array) => Effect.Effect<void, FileSystemError>;
    readonly writeAtomic: (
      path: string,
      content: string | Uint8Array,
    ) => Effect.Effect<void, FileSystemError>;
    readonly exists: (path: string) => Effect.Effect<boolean, FileSystemError>;
    readonly stat: (path: string) => Effect.Effect<FileStat, FileSystemError>;
    readonly lstat: (path: string) => Effect.Effect<FileStat, FileSystemError>;
    readonly mkdir: (path: string) => Effect.Effect<void, FileSystemError>;
    readonly remove: (path: string) => Effect.Effect<void, FileSystemError>;
    readonly readDir: (path: string) => Effect.Effect<ReadonlyArray<string>, FileSystemError>;
    readonly readFile: (path: string) => Effect.Effect<string, FileSystemError>;
    readonly writeFile: (path: string, content: string) => Effect.Effect<void, FileSystemError>;
  }
>()("@lando/core/FileSystem") {}
