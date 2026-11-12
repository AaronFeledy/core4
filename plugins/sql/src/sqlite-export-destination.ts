import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { SqlRecoveryUnavailableError, errnoCode } from "@lando/sdk/errors";
import { Effect } from "effect";
import { coveringSqliteMount, sqliteContainerPath } from "./sqlite-mount.ts";
import { sqliteSidecarPaths } from "./sqlite-path.ts";
import type { SqlFileTarget } from "./target.ts";
import type { SqlPlanService } from "./views.ts";

const fileIdentity = async (path: string) => {
  const info = await stat(path).catch((cause: unknown) => {
    if (errnoCode(cause) === "ENOENT") return undefined;
    throw cause;
  });
  const canonical = await realpath(path).catch(async (cause: unknown) => {
    if (errnoCode(cause) !== "ENOENT") throw cause;
    const parent = await realpath(dirname(path)).catch((parentCause: unknown) => {
      if (errnoCode(parentCause) === "ENOENT") return resolve(dirname(path));
      throw parentCause;
    });
    return join(parent, basename(path));
  });
  return { canonical, info };
};

/** Refuse a destination that is the host copy of the database or a sidecar; only binds have one. */
export const ensureSqliteExportDestination = Effect.fn("Sql.ensureSqliteExportDestination")(function* (
  service: SqlPlanService,
  target: SqlFileTarget,
  destination: string,
) {
  const filePath = sqliteContainerPath(service, target);
  if (filePath === undefined) return;
  const covering = coveringSqliteMount(service, filePath);
  if (covering?.kind !== "bind") return;
  const database = join(covering.source, filePath.slice(covering.target.length));
  yield* Effect.tryPromise({
    try: async () => {
      const output = await fileIdentity(destination);
      for (const path of [database, ...sqliteSidecarPaths(database)]) {
        const protectedFile = await fileIdentity(path);
        if (
          output.canonical === protectedFile.canonical ||
          (output.info !== undefined &&
            protectedFile.info !== undefined &&
            output.info.dev === protectedFile.info.dev &&
            output.info.ino === protectedFile.info.ino)
        ) {
          throw new SqlRecoveryUnavailableError({
            message: `Export destination ${destination} aliases SQLite database ${target.path} or its sidecars.`,
            service: target.name,
            reason: `The destination identifies protected database file ${path}.`,
            remediation:
              "Choose a separate dump file outside the database and its -wal, -shm, and -journal files.",
          });
        }
      }
    },
    catch: (cause) =>
      cause instanceof SqlRecoveryUnavailableError
        ? cause
        : new SqlRecoveryUnavailableError({
            message: `Cannot inspect SQLite export destination ${destination}.`,
            service: target.name,
            reason: String(cause),
            remediation: "Check read permissions on the database and destination directories, then retry.",
          }),
  });
});
