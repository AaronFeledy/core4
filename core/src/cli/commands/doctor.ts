import { Effect, Option, Result } from "effect";

import type { LandoPluginModule } from "@lando/sdk/plugins";
import { ConfigService, PathsService, RuntimeProviderRegistry } from "@lando/sdk/services";

import { bundledPluginModules } from "@lando/engine/composition";
import { PluginContributionGraph } from "@lando/engine/plugins/contribution-graph";
import { pluginDoctorCheckIndex } from "@lando/engine/plugins/doctor-contributions";
import { makePluginCapabilityIndex } from "@lando/engine/plugins/module-set";
import { resolveProviderSelection } from "@lando/engine/providers/precedence";
import { interruptOnAbort } from "./doctor-abort";
import type { DoctorCheck, DoctorResult } from "./doctor-contract";
import {
  buildExecUmaskDoctorCheck,
  collectExecUmaskDoctorCheck,
  diagnoseExecUmask,
} from "./doctor-exec-umask";
import { selectedDoctorFileSyncEngine } from "./doctor-file-sync";
import { hostProxyTransportDoctorChecks } from "./doctor-host-proxy";
import { HostProxyDoctorFileSystem } from "./doctor-host-proxy-filesystem";
import { listenerDoctorChecks } from "./doctor-listeners";
import { collectOomDoctorChecks } from "./doctor-oom";
import {
  isRelevantContribution,
  mapPluginDoctorCheck,
  pluginDoctorReports,
  probeBudgetMs,
} from "./doctor-plugin-checks";
import {
  makeDoctorExecutableLocator,
  makeDoctorResourceInspector,
  resolveDoctorAppIdentity,
} from "./doctor-plugin-context";
import { installedPluginMetadataSelfChecks } from "./doctor-plugin-metadata";
import {
  type ProviderStatusShape,
  UNKNOWN_PROVIDER_VERSION,
  diagnosePrimaryProvider,
  providerStubFor,
  providerUnavailableCheck,
} from "./doctor-provider";
import {
  type ContainerDiedEventCapableProvider,
  buildRuntimeServiceDoctorCheck,
  containerDiedEventPayloadsFor,
  runtimeServiceStatusFor,
  runtimeServiceStatusFromProviderStatus,
} from "./doctor-runtime-service";
import { buildSelectionRecord, gatherSelectionInputs, resolveStateDir } from "./doctor-selection";
import { type DoctorSelfCheck, doctorSectionBudgetMs, isolateDoctorSection } from "./doctor-self";
import { buildSetupReadinessDoctorCheck } from "./doctor-setup-readiness";
import { resolveSecretsRedactor } from "./secrets-redactor";
import { type SetupReadinessSummary, readSetupReadiness } from "./setup-readiness";

export type {
  DoctorCheck,
  DoctorProviderKind,
  DoctorResult,
  DoctorRuntime,
  DoctorSelectionRecord,
  DoctorSeverity,
  DoctorSolution,
  DoctorSolutionKind,
  DoctorStatus,
} from "./doctor-contract";
export { providerKindFor } from "./doctor-contract";
export type { DoctorOptions } from "./doctor-options";
export type { DoctorNdjsonOptions } from "./doctor-render-ndjson";
export { renderDoctorResultAsNdjson } from "./doctor-render-ndjson";
export { renderDoctorResult, renderSolution } from "./doctor-render-text";

import type { DoctorOptions } from "./doctor-options";

export const doctor = Effect.fn("Doctor.collect")(
  function* (
    options: DoctorOptions = {},
    modules?: ReadonlyArray<LandoPluginModule>,
  ): Effect.fn.Return<DoctorResult, never, ConfigService | PathsService | RuntimeProviderRegistry> {
    const configService = yield* ConfigService;
    const paths = yield* PathsService;
    const registry = yield* RuntimeProviderRegistry;
    const sourceEnv = { ...(options.env ?? process.env) };
    const { redactor, redact } = yield* resolveSecretsRedactor({ sourceEnv });
    const sectionBudget = doctorSectionBudgetMs(sourceEnv);
    const probeBudget = probeBudgetMs(sectionBudget);
    const selfChecks: DoctorSelfCheck[] = [];

    const gathered = yield* gatherSelectionInputs(options);
    const resolution = resolveProviderSelection(gathered.inputs);
    const selection = buildSelectionRecord(resolution);
    const stateDir = yield* resolveStateDir(configService);
    const userDataRootRaw = yield* configService.get("userDataRoot");
    const userDataRoot =
      typeof userDataRootRaw === "string" && userDataRootRaw.length > 0 ? userDataRootRaw : undefined;
    if (userDataRoot !== undefined) {
      const metadataOutcome = yield* isolateDoctorSection({
        section: "plugin-metadata",
        effect: installedPluginMetadataSelfChecks(paths.pluginsDir, redact),
        fallback: [],
        budgetMs: probeBudget,
        redact,
      });
      selfChecks.push(...metadataOutcome.value);
      if (metadataOutcome.self !== undefined) selfChecks.push(metadataOutcome.self);
    }
    const platform = options.platform ?? paths.platform;
    const appOutcome = yield* isolateDoctorSection({
      section: "plugin-app-identity",
      effect: resolveDoctorAppIdentity(),
      fallback: undefined,
      budgetMs: probeBudget,
      redact,
    });
    if (appOutcome.self !== undefined) selfChecks.push(appOutcome.self);
    const resources = makeDoctorResourceInspector({
      provider: Effect.suspend(() => registry.select({ provider: resolution.providerId } as never)),
      budgetMs: probeBudget,
      redact,
    });
    const executables = makeDoctorExecutableLocator({
      env: sourceEnv,
      platform,
      execPath: options.execPath ?? process.execPath,
    });
    const graph = yield* Effect.serviceOption(PluginContributionGraph);
    const enabledModules =
      modules ??
      (Option.isSome(graph)
        ? graph.value.plugins.map(({ manifest }) => ({ name: String(manifest.name), manifest }))
        : bundledPluginModules());
    const { reports, selfChecks: pluginSelfChecks } = yield* pluginDoctorReports(
      Effect.suspend(() => {
        const explicit = modules ?? (Option.isNone(graph) ? bundledPluginModules() : undefined);
        const index =
          explicit === undefined
            ? pluginDoctorCheckIndex(Option.getOrThrow(graph).plugins)
            : Result.flatMap(makePluginCapabilityIndex(explicit), () =>
                pluginDoctorCheckIndex(
                  explicit.map((entry) => ({ source: "explicit", manifest: entry.manifest, entry })),
                ),
              );
        return Result.match(index, { onFailure: Effect.fail, onSuccess: Effect.succeed });
      }),
      {
        providerId: String(resolution.providerId),
        app: appOutcome.value,
        resources,
        executables,
        platform,
        stateDir,
        env: options.env ?? process.env,
        userDataRoot,
        binDir: userDataRoot === undefined ? undefined : paths.binDir,
      },
      redactor,
      probeBudget,
    );
    selfChecks.push(...pluginSelfChecks);
    const listeners =
      options.app === true
        ? yield* listenerDoctorChecks({ budgetMs: sectionBudget, redact })
        : ({ checks: [] } satisfies DoctorResult);
    const withSelfChecks = (checks: ReadonlyArray<DoctorCheck>): DoctorResult => ({
      checks: [...checks, ...listeners.checks],
      ...(listeners.skipped === undefined ? {} : { skipped: listeners.skipped }),
      ...(selfChecks.length === 0 ? {} : { selfChecks: [...selfChecks] }),
    });
    const preemptiveReports = reports
      .map((entry) => entry.report)
      .filter((report) => report.preempts === true);
    if (preemptiveReports.length > 0) {
      const providerId = String(resolution.providerId);
      const provider = {
        ...providerStubFor(providerId),
        version: preemptiveReports[0]?.context.providerVersion ?? UNKNOWN_PROVIDER_VERSION,
      };
      return withSelfChecks(
        preemptiveReports.map((report) => mapPluginDoctorCheck({ report, provider, selection })),
      );
    }

    const selected = yield* Effect.result(
      registry.select({
        provider: resolution.providerId,
      } as never),
    );
    if (Result.isFailure(selected)) {
      const providerId = String(resolution.providerId);
      const stub = providerStubFor(providerId);
      return withSelfChecks([
        providerUnavailableCheck({ providerId, platform, selection, cause: selected.failure, redact }),
        ...reports
          .filter((entry) => entry.relevant === undefined)
          .map((entry) => mapPluginDoctorCheck({ report: entry.report, provider: stub, selection })),
      ]);
    }

    const provider = selected.success;
    const statusOutcome = yield* isolateDoctorSection({
      section: "provider-status",
      effect: provider.getStatus,
      fallback: undefined as ProviderStatusShape | undefined,
      budgetMs: probeBudget,
      redact,
    });
    if (statusOutcome.self !== undefined) selfChecks.push(statusOutcome.self);
    const status = statusOutcome.value ?? { running: false };
    const versions = yield* provider.getVersions.pipe(Effect.catch(() => Effect.succeed(undefined)));
    const diagnosis = diagnosePrimaryProvider({
      provider,
      status,
      statusProbe: statusOutcome.self?.reason,
      runtimeVersion: versions?.runtime,
      bundleVersion: versions?.bundle,
      selection,
    });

    const fileSyncSelection = yield* isolateDoctorSection({
      section: "file-sync-selection",
      effect: selectedDoctorFileSyncEngine({
        modules: enabledModules,
        defaultEngine: yield* configService.get("defaultFileSyncEngine"),
        platform,
        capabilities: provider.capabilities,
      }),
      fallback: undefined,
      budgetMs: probeBudget,
      redact,
    });
    if (fileSyncSelection.self !== undefined) selfChecks.push(fileSyncSelection.self);
    const pluginChecks = reports
      .filter((entry) => isRelevantContribution(entry, provider.capabilities))
      .filter(
        ({ report }) =>
          report.context.engineId === undefined || report.context.engineId === fileSyncSelection.value,
      )
      .map((entry) => mapPluginDoctorCheck({ report: entry.report, provider, selection }));
    const setupReadinessOutcome = yield* isolateDoctorSection({
      section: "setup-readiness",
      effect: readSetupReadiness(userDataRoot),
      fallback: undefined as SetupReadinessSummary | undefined,
      redact,
    });
    if (setupReadinessOutcome.self !== undefined) selfChecks.push(setupReadinessOutcome.self);
    const setupReadiness = setupReadinessOutcome.value;
    const setupReadinessChecks =
      setupReadiness === undefined
        ? []
        : [buildSetupReadinessDoctorCheck(setupReadiness, provider, selection)];
    const runtimeServiceChecks: ReadonlyArray<DoctorCheck> =
      diagnosis.statusKnown && diagnosis.providerKind === "managed"
        ? yield* Effect.gen(function* () {
            const outcome = yield* isolateDoctorSection({
              section: "runtime-service-status",
              effect: runtimeServiceStatusFor(provider, status),
              fallback: runtimeServiceStatusFromProviderStatus(status),
              budgetMs: probeBudget,
              redact,
            });
            if (outcome.self !== undefined) selfChecks.push(outcome.self);
            return [
              buildRuntimeServiceDoctorCheck(
                outcome.value,
                provider,
                versions?.runtime,
                setupReadiness?.runtimeService,
                selection,
              ),
            ];
          })
        : [];
    const execUmaskOutcome = yield* isolateDoctorSection({
      section: "exec-umask",
      effect: collectExecUmaskDoctorCheck({
        provider,
        engineVersion: versions?.runtime,
        runtime: diagnosis.runtime,
        runtimeStatus: diagnosis.runtimeMessage,
        selection,
      }),
      fallback: buildExecUmaskDoctorCheck(
        diagnoseExecUmask({ engineVersion: versions?.runtime, stdout: undefined }),
        provider,
        diagnosis.runtime,
        diagnosis.runtimeMessage,
        selection,
      ),
      budgetMs: probeBudget,
      redact,
    });
    if (execUmaskOutcome.self !== undefined) selfChecks.push(execUmaskOutcome.self);
    const diedEventsOutcome = yield* isolateDoctorSection({
      section: "container-died-events",
      effect: containerDiedEventPayloadsFor(
        provider as ContainerDiedEventCapableProvider,
        options.diedEventPayloads,
      ),
      fallback: [] as ReadonlyArray<unknown>,
      budgetMs: probeBudget,
      redact,
    });
    if (diedEventsOutcome.self !== undefined) selfChecks.push(diedEventsOutcome.self);
    const oomChecks = collectOomDoctorChecks(
      diedEventsOutcome.value,
      {
        provider,
        providerKind: diagnosis.providerKind,
        platform: options.platform ?? provider.platform,
      },
      redactor,
    );
    const hostProxyOutcome = yield* isolateDoctorSection({
      section: "host-proxy",
      effect: hostProxyTransportDoctorChecks({
        provider: {
          id: provider.id,
          displayName: provider.displayName,
          version: provider.version,
          ...(provider.capabilities.hostProxy?.tcpHostGateway === undefined
            ? {}
            : { tcpHostGateway: provider.capabilities.hostProxy.tcpHostGateway }),
          exec: provider.exec,
        },
        providerKind: diagnosis.providerKind,
        runtimeStatus: diagnosis.runtimeMessage,
        runtime: diagnosis.runtime,
        selection,
        sourceEnv,
      }).pipe(Effect.provide(HostProxyDoctorFileSystem.layer)),
      fallback: { checks: [] } as DoctorResult,
      redact,
    });
    if (hostProxyOutcome.self !== undefined) selfChecks.push(hostProxyOutcome.self);

    return {
      ...withSelfChecks([
        diagnosis.check,
        ...pluginChecks,
        ...setupReadinessChecks,
        ...runtimeServiceChecks,
        execUmaskOutcome.value,
        ...hostProxyOutcome.value.checks,
        ...oomChecks,
      ]),
      ...(hostProxyOutcome.value.skipped === undefined
        ? {}
        : { skipped: [...(listeners.skipped ?? []), ...hostProxyOutcome.value.skipped] }),
    };
  },
  (effect, options?: DoctorOptions, _modules?: ReadonlyArray<LandoPluginModule>) =>
    interruptOnAbort(effect, options?.signal),
);
