import { bundledPluginModules } from "@lando/engine/composition";
import { PluginContributionGraph } from "@lando/engine/plugins/contribution-graph";
import { pluginDoctorCheckIndex } from "@lando/engine/plugins/doctor-contributions";
import { makePluginCapabilityIndex } from "@lando/engine/plugins/module-set";
import { resolveProviderSelection } from "@lando/engine/providers/precedence";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import { ConfigService, PathsService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { DateTime, Effect, Option, Result } from "effect";
import { CliInvocation } from "../../runtime/invocation-context";
import { interruptOnAbort } from "./doctor-abort";
import { collectArtifactRefreshDoctorCheck } from "./doctor-artifact-refresh";
import type { DoctorFinding, DoctorProvider, DoctorSectionResult, DoctorSkipInput } from "./doctor-contract";
import { providerKindFor } from "./doctor-contract";
import {
  buildExecUmaskDoctorCheck,
  collectExecUmaskDoctorCheck,
  diagnoseExecUmask,
} from "./doctor-exec-umask";
import { selectedDoctorFileSyncEngine } from "./doctor-file-sync";
import { hostProxyTransportDoctorChecks } from "./doctor-host-proxy";
import { HostProxyDoctorFileSystem } from "./doctor-host-proxy-filesystem";
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
import {
  type DoctorSelfFailureReason,
  type DoctorSelfFinding,
  type IsolatedDoctorSection,
  doctorSectionBudgetMs,
  isolateDoctorSection,
} from "./doctor-self";
import { buildSetupReadinessDoctorCheck } from "./doctor-setup-readiness";
import { resolveSecretsRedactor } from "./secrets-redactor";
import { readSetupReadiness } from "./setup-readiness";

export type { DoctorSectionResult } from "./doctor-contract";
export type { DoctorOptions } from "./doctor-options";

import type { DoctorOptions } from "./doctor-options";

/** The probe's self finding carries the classified reason; nothing else reports it. */
const selfFindingReason = (finding: DoctorSelfFinding | undefined): DoctorSelfFailureReason | undefined => {
  if (finding === undefined) return undefined;
  const reason = finding.context.reason;
  return reason === "failure" || reason === "defect" || reason === "timeout" ? reason : undefined;
};

export const doctor = Effect.fn("Doctor.collect")(
  function* (
    options: DoctorOptions = {},
    modules?: ReadonlyArray<LandoPluginModule>,
  ): Effect.fn.Return<DoctorSectionResult, never, ConfigService | PathsService | RuntimeProviderRegistry> {
    const configService = yield* ConfigService;
    const paths = yield* PathsService;
    const registry = yield* RuntimeProviderRegistry;
    const sourceEnv = { ...(options.env ?? (yield* CliInvocation).env) };
    const { redactor, redact } = yield* resolveSecretsRedactor({ sourceEnv });
    const sectionBudget = doctorSectionBudgetMs(sourceEnv);
    const probeBudget = probeBudgetMs(sectionBudget);
    const selfFindings: DoctorSelfFinding[] = [];

    const probeOutcome = <A, E, SR>(
      id: string,
      effect: Effect.Effect<A, E, SR>,
      fallback: A,
      budgetMs = probeBudget,
    ): Effect.Effect<IsolatedDoctorSection<A>, never, SR> =>
      isolateDoctorSection({
        section: "provider",
        probe: id,
        effect,
        fallback,
        budgetMs,
        redact,
      }).pipe(
        Effect.map((outcome) => {
          if (outcome.self !== undefined) selfFindings.push(outcome.self);
          return outcome;
        }),
      );

    const probe = <A, E, SR>(
      id: string,
      effect: Effect.Effect<A, E, SR>,
      fallback: A,
      budgetMs = probeBudget,
    ): Effect.Effect<A, never, SR> =>
      probeOutcome(id, effect, fallback, budgetMs).pipe(Effect.map((outcome) => outcome.value));

    const gathered = yield* gatherSelectionInputs(options);
    const resolution = resolveProviderSelection(gathered.inputs);
    const selection = buildSelectionRecord(resolution);
    const providerId = String(resolution.providerId);
    const stateDir = yield* resolveStateDir(configService);
    const userDataRootRaw = yield* configService.get("userDataRoot");
    const userDataRoot =
      typeof userDataRootRaw === "string" && userDataRootRaw.length > 0 ? userDataRootRaw : undefined;
    if (userDataRoot !== undefined) {
      const metadataFindings = yield* probe(
        "plugin-metadata",
        installedPluginMetadataSelfChecks(paths.pluginsDir, redact),
        [],
      );
      selfFindings.push(...metadataFindings);
    }
    const platform = options.platform ?? paths.platform;
    const app = yield* probe("plugin-app-identity", resolveDoctorAppIdentity(), undefined);
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
        providerId,
        app,
        resources,
        executables,
        platform,
        stateDir,
        env: sourceEnv,
        userDataRoot,
        binDir: userDataRoot === undefined ? undefined : paths.binDir,
      },
      redactor,
      probeBudget,
    );
    selfFindings.push(...pluginSelfChecks);
    const withSelfFindings = (
      findings: ReadonlyArray<DoctorFinding>,
      skipped?: ReadonlyArray<DoctorSkipInput>,
    ) => ({
      checks: [...findings, ...selfFindings],
      ...(skipped === undefined || skipped.length === 0 ? {} : { skipped }),
    });

    const preemptiveReports = reports.filter((entry) => entry.report.preempts === true);
    if (preemptiveReports.length > 0) {
      const version = preemptiveReports[0]?.report.context.providerVersion;
      const provider: DoctorProvider = {
        id: providerId,
        kind: providerKindFor(providerId),
        selection,
        name: providerStubFor(providerId).displayName,
        version: typeof version === "string" ? version : UNKNOWN_PROVIDER_VERSION,
      };
      return {
        ...withSelfFindings(
          preemptiveReports.map((entry) =>
            mapPluginDoctorCheck({ report: entry.report, contributor: entry.contributor }),
          ),
        ),
        provider,
      };
    }

    const selected = yield* Effect.result(
      registry.select({
        provider: resolution.providerId,
      } as never),
    );
    if (Result.isFailure(selected)) {
      const stub = providerStubFor(providerId);
      return {
        ...withSelfFindings([
          providerUnavailableCheck({ providerId, platform, cause: selected.failure, redact }),
          ...reports
            .filter((entry) => entry.relevant === undefined)
            .map((entry) => mapPluginDoctorCheck({ report: entry.report, contributor: entry.contributor })),
        ]),
        provider: {
          id: providerId,
          kind: providerKindFor(providerId),
          selection,
          name: stub.displayName,
          version: stub.version,
          runtimeStatus: "unavailable",
        },
      };
    }

    const provider = selected.success;
    const statusOutcome = yield* probeOutcome(
      "provider-status",
      Effect.result(provider.getStatus),
      undefined,
    );
    const statusResult = statusOutcome.value;
    const statusFailure = statusResult?._tag === "Failure" ? statusResult.failure : undefined;
    const status: ProviderStatusShape =
      statusResult?._tag === "Success"
        ? statusResult.success
        : { state: "running", ...(statusFailure === undefined ? {} : { message: statusFailure.message }) };
    const idle = status.state === "idle";
    const versions = yield* provider.getVersions.pipe(Effect.catch(() => Effect.succeed(undefined)));
    const diagnosis = diagnosePrimaryProvider({
      provider,
      status,
      statusProbe: statusFailure === undefined ? selfFindingReason(statusOutcome.self) : "failure",
      ...(statusFailure === undefined ? {} : { statusFailure }),
      runtimeVersion: versions?.runtime,
      bundleVersion: versions?.bundle,
    });

    const fileSyncEngine = yield* probe(
      "file-sync-selection",
      selectedDoctorFileSyncEngine({
        modules: enabledModules,
        defaultEngine: yield* configService.get("defaultFileSyncEngine"),
        platform,
        capabilities: provider.capabilities,
      }),
      undefined,
    );
    const pluginChecks = reports
      .filter((entry) => isRelevantContribution(entry, provider.capabilities))
      .filter(
        ({ report }) => report.context.engineId === undefined || report.context.engineId === fileSyncEngine,
      )
      .map((entry) => mapPluginDoctorCheck({ report: entry.report, contributor: entry.contributor }));
    const setupReadiness = yield* probe(
      "setup-readiness",
      readSetupReadiness(userDataRoot),
      undefined,
      sectionBudget,
    );
    const setupReadinessChecks =
      setupReadiness === undefined ? [] : [buildSetupReadinessDoctorCheck(setupReadiness)];
    const runtimeServiceChecks: ReadonlyArray<DoctorFinding> =
      diagnosis.statusKnown && diagnosis.providerKind === "managed"
        ? [
            buildRuntimeServiceDoctorCheck(
              yield* probe(
                "runtime-service-status",
                runtimeServiceStatusFor(provider, status),
                runtimeServiceStatusFromProviderStatus(status),
              ),
              versions?.runtime,
              setupReadiness?.runtimeService,
            ),
          ]
        : [];
    const execUmaskCheck = yield* probe(
      "exec-umask",
      collectExecUmaskDoctorCheck({
        provider,
        engineVersion: versions?.runtime,
        running: diagnosis.runtime.running,
      }),
      buildExecUmaskDoctorCheck(diagnoseExecUmask({ engineVersion: versions?.runtime, stdout: undefined })),
    );
    const diedEventPayloads = yield* probe(
      "container-died-events",
      idle
        ? Effect.succeed([])
        : containerDiedEventPayloadsFor(
            provider as ContainerDiedEventCapableProvider,
            options.diedEventPayloads,
          ),
      [] as ReadonlyArray<unknown>,
    );
    const oomChecks = collectOomDoctorChecks(
      diedEventPayloads,
      { platform: options.platform ?? provider.platform },
      redactor,
    );
    const hostProxy = yield* probe(
      "host-proxy",
      hostProxyTransportDoctorChecks({
        runtimeIdle: idle,
        provider: {
          id: provider.id,
          ...(provider.capabilities.hostProxy?.tcpHostGateway === undefined
            ? {}
            : { tcpHostGateway: provider.capabilities.hostProxy.tcpHostGateway }),
          exec: provider.exec,
        },
        sourceEnv,
      }).pipe(Effect.provide(HostProxyDoctorFileSystem.layer)),
      { checks: [] },
      sectionBudget,
    );

    const artifactRefresh = yield* collectArtifactRefreshDoctorCheck({
      runtimeId: provider.runtimeIdentity ?? `${provider.id}:${provider.platform}`,
      now: DateTime.toEpochMillis(yield* DateTime.now),
    }).pipe(Effect.catch(() => Effect.succeed(undefined)));
    return {
      ...withSelfFindings(
        [
          diagnosis.check,
          ...(artifactRefresh === undefined ? [] : [artifactRefresh]),
          ...pluginChecks,
          ...setupReadinessChecks,
          ...runtimeServiceChecks,
          ...(idle ? [] : [execUmaskCheck]),
          ...hostProxy.checks,
          ...oomChecks,
        ],
        [
          ...(hostProxy.skipped ?? []),
          ...(idle
            ? ["exec-umask", "container-died-events", "runtime-oom"].map((check) => ({
                check,
                reason: `Provider ${provider.id} is idle; no live runtime was inspected.`,
              }))
            : []),
        ],
      ),
      provider: {
        id: provider.id,
        kind: diagnosis.providerKind,
        selection,
        name: provider.displayName,
        version: provider.version,
        runtimeStatus: diagnosis.runtimeMessage,
        runtime: diagnosis.runtime,
        capabilities: diagnosis.capabilities,
      },
    };
  },
  (effect, options?: DoctorOptions, _modules?: ReadonlyArray<LandoPluginModule>) =>
    interruptOnAbort(effect, options?.signal),
);
