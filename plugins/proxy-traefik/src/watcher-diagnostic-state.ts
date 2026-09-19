import { Effect, Schema } from "effect";

import { watcherDiagnosticFile } from "./proxy-paths.ts";
import type { ProxyFileSystem, ProxyPaths } from "./proxy-types.ts";

// Remediation text is deliberately not persisted; it is derived at read time from failureClass and watcherHost.
export const WatcherDiagnosticRecord = Schema.Struct({
  version: Schema.Literal(1),
  observedAt: Schema.String,
  providerId: Schema.String,
  watcherHost: Schema.String,
  failureClass: Schema.Literal("inotify-limit", "disk", "permission", "other"),
  detail: Schema.String,
});
export type WatcherDiagnosticRecord = typeof WatcherDiagnosticRecord.Type;

export const writeWatcherDiagnostic = (
  fileSystem: ProxyFileSystem,
  paths: ProxyPaths,
  record: WatcherDiagnosticRecord,
): Effect.Effect<void, unknown> =>
  fileSystem.writeAtomic(watcherDiagnosticFile(paths), `${JSON.stringify(record)}\n`);

export const readWatcherDiagnostic = (
  fileSystem: ProxyFileSystem,
  paths: ProxyPaths,
): Effect.Effect<WatcherDiagnosticRecord | undefined> =>
  fileSystem.readText(watcherDiagnosticFile(paths)).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => Schema.decodeUnknownSync(WatcherDiagnosticRecord)(JSON.parse(text)),
        catch: (error) => error,
      }),
    ),
    Effect.catchAll(() => Effect.succeed(undefined)),
  );

export const clearWatcherDiagnostic = (
  fileSystem: ProxyFileSystem,
  paths: ProxyPaths,
): Effect.Effect<void, unknown> => fileSystem.remove(watcherDiagnosticFile(paths));
