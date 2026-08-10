import { Effect, Either, Option } from "effect";

import type { LandoPluginModule } from "@lando/sdk/plugins";
import { ConfigService, RuntimeProviderRegistry } from "@lando/sdk/services";

import { resolveProviderSelection } from "@lando/engine/providers/precedence";
import { makeLandoPaths } from "@lando/paths";
import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import { BUNDLED_PLUGIN_MODULES } from "../../plugins/generated/bundled";
import { interruptOnAbort } from "./doctor-abort";
import type { DoctorCheck, DoctorResult } from "./doctor-contract";
import { hostProxyTransportDoctorChecks } from "./doctor-host-proxy";
import { HostProxyDoctorFileSystemLive } from "./doctor-host-proxy-filesystem";
import { collectOomDoctorChecks } from "./doctor-oom";
import {
  isRelevantContribution,
  mapPluginDoctorCheck,
  pluginDoctorReports,
  probeBudgetMs,
} from "./doctor-plugin-checks";
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
import {
  buildSelectionRecord,
  gatherSelectionInputs,
  platformFromProcess,
  resolveStateDir,
  selectionConfigFailureCheck,
} from "./doctor-selection";
import { type DoctorSelfCheck, doctorSectionBudgetMs, isolateDoctorSection } from "./doctor-self";
import { buildSetupReadinessDoctorCheck } from "./doctor-setup-readiness";
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

export const doctor = (
  options: DoctorOptions = {},
  modules: ReadonlyArray<LandoPluginModule> = BUNDLED_PLUGIN_MODULES,
): Effect.Effect<DoctorResult, never, ConfigService | RuntimeProviderRegistry> =>
  Effect.gen(function* () {
    const configService = yield* ConfigService;
    const registry = yield* RuntimeProviderRegistry;
    const sourceEnv = { ...(options.env ?? process.env) };
    const redactionService = yield* Effect.serviceOption(RedactionService);
    const redactor = Option.isSome(redactionService)
      ? yield* redactionService.value.forProfile("secrets", { sourceEnv })
      : createStandaloneRedactor("secrets", { sourceEnv });
    const redact = (value: string): string => redactor.redactString(value);
    const probeBudget = probeBudgetMs(doctorSectionBudgetMs(sourceEnv));
    const selfChecks: DoctorSelfCheck[] = [];
    const recordConfigFailure = (section: string, cause: unknown): void => {
      selfChecks.push(selectionConfigFailureCheck(section, cause, redact));
    };

    const gathered = yield* gatherSelectionInputs(options);
    if (gathered.configFailure !== undefined) {
      recordConfigFailure("provider-selection-config", gathered.configFailure);
    }
    const resolution = resolveProviderSelection(gathered.inputs);
    const selection = buildSelectionRecord(resolution);
    const stateDirEither = yield* Effect.either(resolveStateDir(configService));
    if (Either.isLeft(stateDirEither)) recordConfigFailure("provider-state-dir", stateDirEither.left);
    const stateDir = Either.isRight(stateDirEither) ? stateDirEither.right : undefined;
    const userDataRootEither = yield* Effect.either(configService.get("userDataRoot"));
    if (Either.isLeft(userDataRootEither)) {
      recordConfigFailure("provider-user-data-root", userDataRootEither.left);
    }
    const userDataRootRaw = Either.isRight(userDataRootEither) ? userDataRootEither.right : undefined;
    const userDataRoot =
      typeof userDataRootRaw === "string" && userDataRootRaw.length > 0 ? userDataRootRaw : undefined;
    if (userDataRoot !== undefined) {
      const metadataOutcome = yield* isolateDoctorSection({
        section: "plugin-metadata",
        effect: installedPluginMetadataSelfChecks(userDataRoot, redact),
        fallback: [],
        budgetMs: probeBudget,
        redact,
      });
      selfChecks.push(...metadataOutcome.value);
      if (metadataOutcome.self !== undefined) selfChecks.push(metadataOutcome.self);
    }
    const platform = options.platform ?? platformFromProcess();
    const pluginOutcome = yield* pluginDoctorReports(
      modules,
      {
        providerId: String(resolution.providerId),
        platform,
        stateDir,
        env: options.env ?? process.env,
        userDataRoot,
        binDir: userDataRoot === undefined ? undefined : makeLandoPaths({ userDataRoot }).binDir,
      },
      redactor,
      probeBudget,
    );
    const reports = pluginOutcome.reports;
    selfChecks.push(...pluginOutcome.selfChecks);
    const withSelfChecks = (checks: ReadonlyArray<DoctorCheck>): DoctorResult => ({
      checks,
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

    const selected = yield* Effect.either(
      registry.select({
        provider: resolution.providerId,
      } as never),
    );
    if (Either.isLeft(selected)) {
      const providerId = String(resolution.providerId);
      const stub = providerStubFor(providerId);
      return withSelfChecks([
        providerUnavailableCheck({ providerId, platform, selection, cause: selected.left, redact }),
        ...reports
          .filter((entry) => entry.relevant === undefined)
          .map((entry) => mapPluginDoctorCheck({ report: entry.report, provider: stub, selection })),
      ]);
    }

    const provider = selected.right;
    const statusOutcome = yield* isolateDoctorSection({
      section: "provider-status",
      effect: provider.getStatus,
      fallback: undefined as ProviderStatusShape | undefined,
      budgetMs: probeBudget,
      redact,
    });
    if (statusOutcome.self !== undefined) selfChecks.push(statusOutcome.self);
    const status = statusOutcome.value ?? { running: false };
    const versions = yield* provider.getVersions.pipe(Effect.catchAll(() => Effect.succeed(undefined)));
    const diagnosis = diagnosePrimaryProvider({
      provider,
      status,
      statusProbe: statusOutcome.self?.reason,
      runtimeVersion: versions?.runtime,
      bundleVersion: versions?.bundle,
      selection,
    });

    const pluginChecks = reports
      .filter((entry) => isRelevantContribution(entry, provider.capabilities))
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
    const oomChecks = collectOomDoctorChecks(
      yield* containerDiedEventPayloadsFor(
        provider as ContainerDiedEventCapableProvider,
        options.diedEventPayloads,
      ),
      {
        provider,
        providerKind: diagnosis.providerKind,
        platform: options.platform ?? provider.platform,
      },
    );
    const hostProxyOutcome = yield* isolateDoctorSection({
      section: "host-proxy",
      effect: hostProxyTransportDoctorChecks({
        ...(userDataRoot === undefined ? {} : { userDataRoot }),
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
      }).pipe(Effect.provide(HostProxyDoctorFileSystemLive)),
      fallback: [] as ReadonlyArray<DoctorCheck>,
      redact,
    });
    if (hostProxyOutcome.self !== undefined) selfChecks.push(hostProxyOutcome.self);

    return withSelfChecks([
      diagnosis.check,
      ...pluginChecks,
      ...setupReadinessChecks,
      ...runtimeServiceChecks,
      ...hostProxyOutcome.value,
      ...oomChecks,
    ]);
  }).pipe((effect) => interruptOnAbort(effect, options.signal));
