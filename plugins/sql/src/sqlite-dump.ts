import { mapFailures } from "@lando/sdk/command-result";
import { SqlDumpIncompleteError, SqlRecoveryUnavailableError } from "@lando/sdk/errors";
import { persistVerifiedStream } from "@lando/sdk/verified-stream";
import { Effect, Stream } from "effect";

import type { ExportDestination } from "./actions.ts";
import { type DumpCompression, compressDumpStream } from "./compression.ts";
import { ensureSqliteExportDestination } from "./sqlite-export-destination.ts";
import { runSqliteHelper, sqliteScratchFile, withSqliteHelper } from "./sqlite-helper.ts";
import { captureSqliteDatabase } from "./sqlite-snapshot-capture.ts";
import type { SqliteSnapshotDeps } from "./sqlite-snapshot.ts";
import type { SqlFileTarget } from "./target.ts";
import type { SqlPlanService } from "./views.ts";

const SQLITE_HEADER_PRAGMAS_SQL =
  "SELECT 'PRAGMA user_version=' || user_version || ';' FROM pragma_user_version " +
  "UNION ALL SELECT 'PRAGMA application_id=' || application_id || ';' FROM pragma_application_id;";

// `.dump` reports an unopenable database on stderr yet exits 0 with no output. A
// complete export closes its transaction and then carries both header pragmas.
const COMPLETE_DUMP_TAIL = [/^COMMIT;$/u, /^PRAGMA user_version=-?\d+;$/u, /^PRAGMA application_id=-?\d+;$/u];

export const sqliteExportFormat = (path: string): "sql" | "sqlite" =>
  /\.(sqlite3?|db3?)(\.(gz|zst))?$/iu.test(path) ? "sqlite" : "sql";

const requireCompleteSqliteDump = (staged: string, path: string, service: string) =>
  Effect.tryPromise({
    try: async () => {
      const file = Bun.file(staged);
      const tail = (await file.slice(Math.max(0, file.size - 256)).text())
        .split("\n")
        .filter((line) => line.length > 0)
        .slice(-COMPLETE_DUMP_TAIL.length);
      return {
        empty: file.size === 0,
        complete:
          tail.length === COMPLETE_DUMP_TAIL.length &&
          COMPLETE_DUMP_TAIL.every((pattern, index) => pattern.test(tail[index] ?? "")),
      };
    },
    catch: (cause) =>
      new SqlRecoveryUnavailableError({
        message: "Cannot read the staged SQLite dump.",
        service,
        reason: String(cause),
        remediation: "Check snapshot scratch permissions and disk health, then retry the export.",
      }),
  }).pipe(
    Effect.flatMap(({ empty, complete }) =>
      complete
        ? Effect.void
        : Effect.fail(
            new SqlDumpIncompleteError({
              message: empty
                ? `SQLite produced an empty dump of ${service}.`
                : `SQLite produced a truncated dump of ${service}.`,
              path,
              reason: empty ? "empty" : "truncated",
              remediation:
                "Check that the database opens with sqlite3 inside the service, then retry the export. Any existing export file was left unchanged.",
            }),
          ),
    ),
  );

export const exportSqliteDump = Effect.fn("Sql.exportSqliteDump")(function* (input: {
  readonly sqlite: SqliteSnapshotDeps;
  readonly service: SqlPlanService;
  readonly target: SqlFileTarget;
  readonly destination: ExportDestination;
  readonly compression: DumpCompression;
  readonly compressionLevel?: number;
}) {
  if (input.destination._tag === "file") {
    yield* ensureSqliteExportDestination(input.service, input.target, input.destination.path);
  }
  return yield* withSqliteHelper(input.sqlite, input.service, input.target, (helper) =>
    Effect.gen(function* () {
      const format = input.destination._tag === "file" ? sqliteExportFormat(input.destination.path) : "sql";
      const dump =
        format === "sqlite"
          ? yield* captureSqliteDatabase(input.sqlite, input.target, helper)
          : sqliteScratchFile(helper, ".sql");
      if (format === "sql") {
        yield* runSqliteHelper(input.sqlite, input.target, helper, [
          "sh",
          "-c",
          // `.dump` omits the header pragmas apps use as schema versions; append them so its
          // leading defensive-mode comment stays first, where sqlite3 honors it on import.
          `sqlite3 -bail -readonly -ifexists "$1" ".dump --preserve-rowids" "${SQLITE_HEADER_PRAGMAS_SQL}" > "$2"`,
          "sqlite-dump",
          helper.dbPath,
          dump.target,
        ]);
        yield* requireCompleteSqliteDump(
          dump.host,
          input.destination._tag === "file" ? input.destination.path : "-",
          input.target.name,
        );
      }
      const destination = input.destination;
      const source = Stream.fromReadableStream({
        evaluate: () => Bun.file(dump.host).stream(),
        onError: (cause) =>
          new SqlRecoveryUnavailableError({
            message: "Cannot read the staged SQLite dump.",
            service: input.target.name,
            reason: String(cause),
            remediation: "Check snapshot scratch permissions and disk health, then retry the export.",
          }),
      });
      const body =
        input.compression === "none"
          ? source
          : compressDumpStream(source, input.compression, input.compressionLevel);
      switch (destination._tag) {
        case "stdout": {
          let sizeBytes = 0;
          yield* Stream.runForEach(body, (chunk) =>
            Effect.suspend(() => {
              sizeBytes += chunk.byteLength;
              return destination.write(chunk);
            }),
          );
          return { accelerated: false as const, sizeBytes, format };
        }
        case "file":
          return yield* persistVerifiedStream({ body, destinationPath: destination.path, mode: 0o600 }).pipe(
            Effect.map((result) => ({ accelerated: false as const, sizeBytes: result.sizeBytes, format })),
            mapFailures(
              (cause) =>
                new SqlRecoveryUnavailableError({
                  message: `Cannot publish SQLite export ${destination.path}.`,
                  service: input.target.name,
                  reason: String(cause),
                  remediation: "Check destination permissions and available disk space, then retry.",
                }),
            ),
          );
      }
    }),
  );
});
