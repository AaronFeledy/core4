import { Effect, Schema } from "effect";
import { FILE_IO_REASONS, fileIoReason } from "./errno.ts";

const Remediation = Schema.NonEmptyString.check(Schema.isPattern(/\S/u));

export class FileNotFoundError extends Schema.TaggedError<FileNotFoundError>()("FileNotFoundError", {
  message: Schema.String,
  path: Schema.String,
  remediation: Remediation.pipe(
    Schema.withConstructorDefault(
      Effect.succeed("Create the missing path or correct the path in configuration, then retry."),
    ),
  ),
  cause: Schema.optional(Schema.Unknown),
}) {}

export class FilePermissionError extends Schema.TaggedError<FilePermissionError>()("FilePermissionError", {
  message: Schema.String,
  path: Schema.String,
  remediation: Remediation.pipe(
    Schema.withConstructorDefault(
      Effect.succeed("Fix ownership or permissions on the reported path, then retry."),
    ),
  ),
  cause: Schema.optional(Schema.Unknown),
}) {}

export const FileIoOperation = Schema.Literals(["read", "stage", "persist"]);
export type FileIoOperation = typeof FileIoOperation.Type;

export const FileIoReason = Schema.Literals(FILE_IO_REASONS);
export type FileIoReason = typeof FileIoReason.Type;

export class FileIoError extends Schema.TaggedError<FileIoError>()("FileIoError", {
  message: Schema.String,
  path: Schema.String,
  operation: Schema.optionalKey(FileIoOperation),
  reason: Schema.optionalKey(FileIoReason),
  remediation: Remediation,
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Construct at the filesystem I/O boundary with an owner-selected operation and path.
 * Native messages, stacks, custom fields and nested causes are deliberately discarded.
 */
export const safeFileIoError = (operation: FileIoOperation, path: string, cause: unknown): FileIoError => {
  const reason = fileIoReason(cause);
  const location = {
    read: "readable source",
    stage: "writable staging location",
    persist: "writable destination location",
  }[operation];
  const explanation = {
    "permission-denied": "Permission denied",
    "read-only": "The filesystem is read-only",
    "no-space": "The filesystem has no free space",
    "quota-exceeded": "The storage quota is exhausted",
    "not-found": "The path or a parent directory is missing",
    "invalid-path": "The path is invalid for this file operation",
    io: "The filesystem reported an I/O failure",
    unknown: "The filesystem operation failed",
  } satisfies Record<FileIoReason, string>;
  const remediation = {
    "permission-denied": `Check ownership and permissions on the path and its parent directories, or choose a ${location}, then retry.`,
    "read-only": `Check the filesystem mount settings or choose a ${location} on another filesystem, then retry.`,
    "no-space": "Free space or inodes on the host filesystem, or choose another filesystem, then retry.",
    "quota-exceeded": "Free storage within your host quota or request a quota increase, then retry.",
    "not-found":
      "Check that the path and required parent directories exist, or correct the path, then retry.",
    "invalid-path":
      "Check the path length, directory components, symlink targets and file type, or choose another path, then retry.",
    io: "Check the host filesystem and storage device health, or choose another filesystem, then retry.",
    unknown:
      "Check that the path and its parent directories are accessible and the host filesystem is healthy, then retry.",
  } satisfies Record<FileIoReason, string>;
  return new FileIoError({
    operation,
    path,
    reason,
    message: `Failed to ${operation} file at ${path}: ${explanation[reason]}.`,
    remediation: remediation[reason],
  });
};
