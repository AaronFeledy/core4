import { randomUUID } from "node:crypto";
import { lstat, readdir, rm } from "node:fs/promises";
import { join, sep } from "node:path";
import { SqlRecoveryUnavailableError } from "@lando/sdk/errors";
import { Effect } from "effect";
import { SQLITE_HEADER_BYTES, isSqliteDatabaseHeader } from "./sqlite-header.ts";
import type { SqliteHelperContext } from "./sqlite-helper.ts";

export const sqliteScratchFile = (helper: SqliteHelperContext, suffix: string) => {
  const name = `${randomUUID()}${suffix}`;
  return { host: join(helper.scratchHost, name), target: `${helper.scratchTarget}/${name}`, name };
};

export const copyHostFile = (from: string, to: string, service: string, message: string) =>
  Effect.tryPromise({
    try: async () => {
      const writer = Bun.file(to).writer();
      try {
        for await (const chunk of Bun.file(from).stream()) writer.write(chunk);
      } finally {
        await writer.end();
      }
    },
    catch: (cause) =>
      new SqlRecoveryUnavailableError({
        message,
        service,
        reason: String(cause),
        remediation: "Check permissions on the Lando user data directory, then retry.",
      }),
  });

export const hostFileSize = (path: string): number => Bun.file(path).size;

export const requireSqliteDatabaseHeader = (path: string, service: string, message: string) =>
  Effect.tryPromise({
    try: async () => {
      const info = await lstat(path);
      if (!info.isFile()) throw new Error("The SQLite payload must be a regular file.");
      const prefix = new Uint8Array(await Bun.file(path).slice(0, SQLITE_HEADER_BYTES).arrayBuffer());
      if (!isSqliteDatabaseHeader(prefix))
        throw new Error("The file does not start with the SQLite format 3 header.");
    },
    catch: (cause) =>
      new SqlRecoveryUnavailableError({
        message,
        service,
        reason: String(cause),
        remediation: "Confirm the payload is a regular SQLite database, then retry.",
      }),
  });

export const removeSqliteHelperScratch = (path: string, service = "sqlite", recoveryFile?: string) =>
  Effect.tryPromise({
    try: async () => {
      if (recoveryFile === undefined) return rm(path, { recursive: true, force: true });
      const clean = async (directory: string): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const child = join(directory, entry.name);
          if (child === recoveryFile) continue;
          if (entry.isDirectory() && recoveryFile.startsWith(`${child}${sep}`)) await clean(child);
          else await rm(child, { recursive: true, force: true });
        }
      };
      await clean(path);
    },
    catch: (cause) =>
      new SqlRecoveryUnavailableError({
        message: `Cannot remove SQLite helper scratch at ${path}.`,
        service,
        reason: String(cause),
        remediation:
          "Check scratch ownership and permissions. Preserve recovery evidence before removing retained files.",
      }),
  });
