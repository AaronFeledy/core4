import type { AppPlanner, LandofileService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { PathsService, StateStore } from "@lando/sdk/services";
import { Effect } from "effect";

import { planDesiredApp } from "../landofile/app-resolution.ts";
import { appSteps } from "../services/build-app-plan.ts";
import { BuildOwner } from "../services/build-owner.ts";
import { type BuildResultEntry, openAppBuildResults } from "../services/build-results.ts";
import { makeBuildTranscriptAppDir, readBuildTranscriptLines } from "../services/build-transcript.ts";
import { type LogsAppError, type LogsAppLine, type LogsAppResult, selectLogServices } from "./logs.ts";

const BUILD_SOURCE = "build";

export interface BuildLogsAppOptions {
  readonly service?: string;
  readonly tail?: number;
}

export type BuildLogsAppResult = LogsAppResult & {
  readonly lines: ReadonlyArray<LogsAppLine>;
};

const latestEntryFor = (
  entries: ReadonlyArray<BuildResultEntry>,
  input: Pick<BuildResultEntry, "service" | "phase"> & { readonly step?: string },
): BuildResultEntry | undefined => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry !== undefined &&
      entry.service === input.service &&
      entry.phase === input.phase &&
      entry.step === input.step
    ) {
      return entry;
    }
  }
  return undefined;
};

/**
 * Print the recorded output of an app's most recent build. Plans from the current Landofile, so a
 * service whose first image build failed is still selectable; no provider is selected or contacted.
 */
export const buildLogsApp = Effect.fn("AppOperation.buildLogs")(function* (
  options: BuildLogsAppOptions = {},
): Effect.fn.Return<
  BuildLogsAppResult,
  LogsAppError,
  AppPlanner | LandofileService | RuntimeProviderRegistry | PathsService | StateStore
> {
  const { plan } = yield* planDesiredApp;
  const paths = yield* PathsService;
  const stateStore = yield* StateStore;
  const services = yield* selectLogServices(plan, options.service);
  // `lando logs` plans the app in the current directory, which is never a scratch app.
  const owner = BuildOwner.fromPlan(plan);
  const bucket = yield* openAppBuildResults(stateStore, owner);
  const entries = (yield* bucket.get) ?? [];
  const appDir = makeBuildTranscriptAppDir({
    userDataRoot: paths.roots.userDataRoot,
    owner,
  });
  const lines: LogsAppLine[] = [];
  const steps = appSteps(plan);

  const append = Effect.fnUntraced(function* (entry: BuildResultEntry, source: string) {
    const transcript = yield* readBuildTranscriptLines({
      providerId: String(plan.provider),
      userDataRoot: paths.roots.userDataRoot,
      appDir,
      path: entry.transcriptPath,
      ...(options.tail === undefined ? {} : { tail: options.tail }),
    });
    if (transcript === undefined) return;
    for (const line of transcript) {
      lines.push({ service: String(entry.service), stream: "stdout", line, source });
    }
  });

  for (const service of services) {
    const artifact = latestEntryFor(entries, { service: service.name, phase: "artifact" });
    if (artifact !== undefined) yield* append(artifact, BUILD_SOURCE);
    for (const { step } of steps) {
      if (step.service !== service.name) continue;
      const entry = latestEntryFor(entries, { service: service.name, phase: "app", step: step.id });
      if (entry !== undefined) yield* append(entry, `${BUILD_SOURCE}:${step.id}`);
    }
  }

  return { app: plan.name, lines };
});
