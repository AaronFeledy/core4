import { readFile } from "node:fs/promises";

import { makeLandoPaths } from "@lando/paths";
import type { PluginDoctorCheckContribution, PluginDoctorReport } from "@lando/sdk/plugins";
import { Effect, Schema } from "effect";

import { watcherDiagnosticFile } from "./proxy-paths.ts";
import type { ProxyPaths } from "./proxy-types.ts";
import { WatcherDiagnosticRecord } from "./watcher-diagnostic-state.ts";
import { watcherRemediations } from "./watcher-diagnostics.ts";

export type { WatcherDiagnosticRecord };

type DoctorRunInput = Parameters<PluginDoctorCheckContribution["run"]>[0];

const LAST_OBSERVATION = "This is the last router setup observation and has not been revalidated.";

const readStoredRecord = (paths: ProxyPaths): Effect.Effect<WatcherDiagnosticRecord | undefined> =>
  Effect.tryPromise(() => readFile(watcherDiagnosticFile(paths), "utf8")).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => Schema.decodeUnknownSync(WatcherDiagnosticRecord)(JSON.parse(text)),
        catch: (error) => error,
      }),
    ),
    Effect.catchAll(() => Effect.succeed(undefined)),
  );

const watcherReport = (record: WatcherDiagnosticRecord): PluginDoctorReport =>
  ({
    name: "router-file-watcher",
    status: "fail",
    severity: "error",
    runtimeStatus: "file-watcher-failed",
    runtime: { running: false },
    context: {
      proxyId: "traefik",
      failureClass: record.failureClass,
      watcherHost: record.watcherHost,
      providerId: record.providerId,
      observedAt: record.observedAt,
      detail: record.detail,
      observation: LAST_OBSERVATION,
    },
    solutions: [...watcherRemediations(record.failureClass, record.watcherHost)],
  }) satisfies PluginDoctorReport;

export const makeRouterFileWatcherCheck = (
  readRecord?: (input: DoctorRunInput) => Effect.Effect<WatcherDiagnosticRecord | undefined>,
): PluginDoctorCheckContribution => ({
  id: "router-file-watcher",
  run: (input) => {
    if (input.userDataRoot === undefined) return Effect.succeed([]);
    const resolved = makeLandoPaths({ userDataRoot: input.userDataRoot, platform: input.platform });
    const paths: ProxyPaths = { platform: resolved.platform, globalAppRoot: resolved.globalAppRoot };
    return Effect.gen(function* () {
      const record = yield* (readRecord ?? (() => readStoredRecord(paths)))(input);
      if (record === undefined) return [];
      if (record.providerId !== input.providerId) return [];
      return [watcherReport(record)];
    });
  },
});

export const routerFileWatcherCheck = makeRouterFileWatcherCheck();
