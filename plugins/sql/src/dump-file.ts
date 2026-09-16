import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";

import { Effect } from "effect";

import { SqlDumpNotFoundError } from "@lando/sdk/errors";

type DumpMiss = "missing" | "unreadable" | "directory";

const nodeErrorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;

const dumpMissKind = (cause: unknown): DumpMiss => {
  const code = nodeErrorCode(cause);
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
  readonly gzip: boolean;
};

const isGzipMagic = (chunk: Uint8Array): boolean =>
  chunk.length >= 2 && chunk[0] === 0x1f && chunk[1] === 0x8b;

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
      let gzip = false;
      let sawPrefix = false;
      for await (const chunk of Bun.file(path).stream()) {
        if (!sawPrefix) {
          gzip = isGzipMagic(chunk);
          sawPrefix = true;
        }
        hash.update(chunk);
      }
      return { digest: hash.digest("hex"), gzip };
    },
    catch: (cause) =>
      cause instanceof SqlDumpNotFoundError ? cause : dumpNotFound(path, appRoot, dumpMissKind(cause)),
  });
