import { constants } from "node:fs";
import { access, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, type Stream } from "effect";

import {
  type CommandStdioError,
  DataTransferError,
  SqlDumpNotFoundError,
  errnoCode,
} from "@lando/sdk/errors";
import { persistVerifiedStream } from "@lando/sdk/verified-stream";

import {
  type DumpCompression,
  collectDumpPrefix,
  detectDumpCompression,
  releaseStagedDump,
} from "./compression.ts";

type DumpMiss = "missing" | "unreadable" | "directory";

const dumpMissKind = (cause: unknown): DumpMiss => {
  const code = errnoCode(cause);
  if (code === "EACCES" || code === "EPERM") return "unreadable";
  return "missing";
};

const dumpNotFound = (path: string, appRoot: string, kind: DumpMiss): SqlDumpNotFoundError => {
  const message =
    kind === "unreadable"
      ? `Dump file is not readable: ${path}`
      : kind === "directory"
        ? `Dump path is a directory, not a file: ${path}`
        : `Dump file not found: ${path}`;
  return new SqlDumpNotFoundError({
    message,
    path,
    appRoot,
    remediation: `Check the path. Relative paths resolve from the current directory when inside the app, otherwise from the app root (${appRoot}).`,
  });
};

export type ReadableDump = {
  readonly digest: string;
  readonly compression: DumpCompression;
};

export const ensureReadableDump = (
  path: string,
  appRoot: string,
): Effect.Effect<ReadableDump, SqlDumpNotFoundError> =>
  Effect.tryPromise({
    try: async () => {
      const info = await stat(path);
      if (info.isDirectory()) throw dumpNotFound(path, appRoot, "directory");
      // `stat` succeeds on a file the current user cannot open; ask for read
      // permission explicitly so import fails here, before the count probe and
      // overwrite confirmation, instead of inside DataMover.
      await access(path, constants.R_OK);
      const hash = new Bun.CryptoHasher("sha256");
      let prefix: Uint8Array = new Uint8Array();
      for await (const chunk of Bun.file(path).stream()) {
        prefix = collectDumpPrefix(chunk, prefix);
        hash.update(chunk);
      }
      return { digest: hash.digest("hex"), compression: detectDumpCompression(prefix) };
    },
    catch: (cause) =>
      cause instanceof SqlDumpNotFoundError ? cause : dumpNotFound(path, appRoot, dumpMissKind(cause)),
  });

const stdinStageError = (cause: unknown): DataTransferError =>
  new DataTransferError({
    message: "Failed to save the dump from stdin to a temporary file.",
    fromEndpoint: "stdin",
    toEndpoint: "hostPath",
    operation: "stage",
    remediation: "Check that the host temp directory is writable and has room for the dump, then retry.",
    cause,
  });

/** Saves a stdin dump to an owner-only temporary file that lives until the surrounding scope closes. */
export const stageStdinDump = Effect.fnUntraced(function* (
  stdin: Stream.Stream<Uint8Array, CommandStdioError>,
) {
  const directory = yield* Effect.acquireRelease(
    Effect.tryPromise({ try: () => mkdtemp(join(tmpdir(), "lando-dump-")), catch: stdinStageError }),
    releaseStagedDump,
  );
  const path = join(directory, "dump");
  yield* persistVerifiedStream({ body: stdin, destinationPath: path, mode: 0o600 }).pipe(
    Effect.catchTag("VerifiedStreamError", (error) => Effect.fail(stdinStageError(error))),
  );
  return path;
});
