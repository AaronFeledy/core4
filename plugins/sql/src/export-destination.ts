import { lstat, stat } from "node:fs/promises";
import { CommandInputValidationError, DataTransferError, errnoCode } from "@lando/sdk/errors";
import { Effect } from "effect";

/** Refuse non-files before atomic replacement can destroy them or bypass a pipe. */
export const ensureExportDestination = (
  path: string,
): Effect.Effect<void, CommandInputValidationError | DataTransferError> =>
  Effect.tryPromise({
    try: () =>
      stat(path).catch(async (cause: unknown) => {
        const code = errnoCode(cause);
        if (code !== "ENOENT" && code !== "ENOTDIR") throw cause;
        // A dangling symlink still exists, and the export would replace the link itself.
        return lstat(path).catch(() => undefined);
      }),
    catch: (cause) =>
      new DataTransferError({
        message: `Failed to inspect the export destination: ${path}`,
        toEndpoint: "hostPath",
        operation: "inspect",
        remediation: "Check that the destination's directory exists and is readable, then retry the export.",
        cause,
      }),
  }).pipe(
    Effect.flatMap((info) => {
      if (info === undefined || info.isFile()) return Effect.void;
      let message: string;
      let remediation: string;
      if (info.isDirectory()) {
        message = `Export destination is a directory: ${path}`;
        remediation = "Pass a file path, for example a dump.sql.gz inside that directory.";
      } else if (info.isSymbolicLink()) {
        message = `Export destination is a symbolic link to a missing file: ${path}`;
        remediation = "Point the link at an existing file, remove it, or pass another path.";
      } else {
        message = `Export destination is not a regular file: ${path}`;
        remediation = `To stream into a pipe or another program, pass - and redirect stdout: lando db:export - > ${path}`;
      }
      return Effect.fail(
        new CommandInputValidationError({
          message,
          remediation,
          target: "db:export",
          field: "file",
          kind: "arg",
          reason: "constraint",
        }),
      );
    }),
  );
