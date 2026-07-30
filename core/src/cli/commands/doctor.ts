import { Effect, Either, Option } from "effect";

import type { ConfigError } from "@lando/sdk/errors";
import type {
  LandoPluginModule,
  PluginDoctorCheckContribution,
  PluginDoctorReport,
} from "@lando/sdk/plugins";
import {
  type HostPlatform,
  ProviderCapabilities,
  type ProviderCapabilities as ProviderCapabilitiesShape,
  ProviderId,
} from "@lando/sdk/schema";
import { ConfigService, type ProviderError, RuntimeProviderRegistry } from "@lando/sdk/services";

import { makeLandoPaths } from "@lando/paths";
import { BUNDLED_PLUGIN_MODULES } from "../../plugins/generated/bundled.ts";
import { makePluginCapabilityIndex } from "../../plugins/module-set.ts";
import {
  CAPABILITY_DEFAULT_PROVIDER_ID,
  type ProviderSelectionInputs,
  type ProviderSelectionResolution,
  type ProviderSelectionSource,
  readProviderEnvVar,
  resolveProviderSelection,
} from "../../providers/precedence.ts";
import { RedactionService, createStandaloneRedactor } from "../../redaction/service.ts";
import { HostProxyDoctorFileSystemLive } from "./doctor-host-proxy-filesystem.ts";
import { hostProxyTransportDoctorChecks } from "./doctor-host-proxy.ts";
import { orderKnownKeys, renderDoctorChecksAsNdjson } from "./doctor-ndjson.ts";
import { collectOomDoctorChecks } from "./doctor-oom.ts";
import {
  type DoctorSelfCheck,
  type DoctorSelfSolution,
  describeDoctorFailure,
  doctorSectionBudgetMs,
  doctorSelfCheck,
  isolateDoctorSection,
} from "./doctor-self.ts";
import {
  type SetupReadinessRuntimeService,
  type SetupReadinessSummary,
  readSetupReadiness,
} from "./setup-readiness.ts";

export type DoctorStatus = "pass" | "warn" | "fail";
export type DoctorSeverity = "info" | "warn" | "error";
export type DoctorSolutionKind = "automatic" | "manual";
export type DoctorProviderKind = "managed" | "user-installed";

const MANAGED_PROVIDER_IDS: ReadonlySet<string> = new Set(["lando"]);

export const providerKindFor = (providerId: string): DoctorProviderKind =>
  MANAGED_PROVIDER_IDS.has(providerId) ? "managed" : "user-installed";

export interface DoctorSolution {
  readonly kind: DoctorSolutionKind;
  readonly description: string;
  readonly command?: string;
}

export interface DoctorRuntime {
  readonly running: boolean;
  readonly message?: string;
  readonly version?: string;
  // Present only when a container died event reported the OOMKilled attribute.
  readonly oomKilled?: boolean;
}

export interface DoctorSelectionRecord {
  readonly providerId: string;
  readonly source: ProviderSelectionSource;
  readonly inputs: {
    readonly flag?: string;
    readonly landofile?: string;
    readonly env?: string;
    readonly config?: string;
    readonly capabilityDefault: string;
  };
}

export interface DoctorCheck {
  readonly name: string;
  readonly status: DoctorStatus;
  readonly severity: DoctorSeverity;
  readonly providerId: string;
  readonly providerName: string;
  readonly providerVersion: string;
  readonly providerKind: DoctorProviderKind;
  readonly runtimeStatus: string;
  readonly runtime: DoctorRuntime;
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly context: Readonly<Record<string, string>>;
  readonly solutions: ReadonlyArray<DoctorSolution>;
  readonly selection?: DoctorSelectionRecord;
}

export interface DoctorResult {
  readonly checks: ReadonlyArray<DoctorCheck>;
  /**
   * Failures of doctor's own machinery while producing the provider section.
   * Lifted into the report-level `self` section by `doctorReport`.
   */
  readonly selfChecks?: ReadonlyArray<DoctorSelfCheck>;
}

export interface DoctorOptions {
  /**
   * Explicit `--provider` value provided on the CLI.
   */
  readonly flagProviderId?: string | undefined;
  /**
   * Landofile-declared `provider:` field.
   */
  readonly landofileProviderId?: string | undefined;
  /**
   * Environment lookup used for `LANDO_PROVIDER`. Defaults to `process.env`.
   */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /**
   * Host platform used when resolving the Podman socket for the
   * provider-conflict check. Defaults to the active host's platform.
   */
  readonly platform?: HostPlatform | undefined;
  /**
   * When `true`, `lando doctor --fix` re-runs the setup step of each degraded
   * subsystem whose recovery is safe to automate. Defaults to `false`.
   */
  readonly fix?: boolean | undefined;
  /**
   * When `true`, `lando doctor --app` additionally lints the current app's
   * Landofile against the canonical schema (the same pass as
   * `lando app:config:lint`). Defaults to `false`.
   */
  readonly app?: boolean | undefined;
  readonly deprecations?: boolean | undefined;
  readonly diedEventPayloads?: ReadonlyArray<unknown> | undefined;
  readonly format?: "text" | "json" | "yaml" | undefined;
}

const CAPABILITY_FIELDS = Object.keys(ProviderCapabilities.fields) as ReadonlyArray<
  keyof ProviderCapabilitiesShape
>;

const SETUP_REMEDIATION: DoctorSolution = {
  kind: "manual",
  description:
    "Selected runtime provider is not running. Run `lando setup` to provision the managed runtime, then retry.",
  command: "lando setup",
};

const branded = (value: string | undefined): ProviderId | undefined => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return ProviderId.make(trimmed);
};

const platformFromProcess = (): HostPlatform => {
  if (process.platform === "linux") return "linux";
  if (process.platform === "darwin") return "darwin";
  return "win32";
};

const buildSelectionRecord = (resolution: ProviderSelectionResolution): DoctorSelectionRecord => ({
  providerId: String(resolution.providerId),
  source: resolution.source,
  inputs: {
    ...(resolution.inputs.flag === undefined ? {} : { flag: String(resolution.inputs.flag) }),
    ...(resolution.inputs.landofile === undefined ? {} : { landofile: String(resolution.inputs.landofile) }),
    ...(resolution.inputs.env === undefined ? {} : { env: String(resolution.inputs.env) }),
    ...(resolution.inputs.config === undefined ? {} : { config: String(resolution.inputs.config) }),
    capabilityDefault: String(resolution.inputs.capabilityDefault),
  },
});

interface GatheredSelectionInputs {
  readonly inputs: ProviderSelectionInputs;
  /**
   * Present when the configured default could not be read. Flag, Landofile,
   * and env inputs are unaffected, so selection still resolves.
   */
  readonly configFailure?: unknown;
}

const gatherSelectionInputs = (
  options: DoctorOptions,
): Effect.Effect<GatheredSelectionInputs, never, ConfigService> =>
  Effect.gen(function* () {
    const configService = yield* ConfigService;
    const configProvider = yield* Effect.either(configService.get("defaultProviderId"));

    const flag = branded(options.flagProviderId);
    const landofile = branded(options.landofileProviderId);
    const env = readProviderEnvVar(options.env ?? process.env);
    const config = Either.isRight(configProvider) ? (configProvider.right ?? undefined) : undefined;
    return {
      inputs: {
        ...(flag === undefined ? {} : { flag }),
        ...(landofile === undefined ? {} : { landofile }),
        ...(env === undefined ? {} : { env }),
        ...(config === undefined ? {} : { config }),
        capabilityDefault: CAPABILITY_DEFAULT_PROVIDER_ID,
      },
      ...(Either.isLeft(configProvider) ? { configFailure: configProvider.left } : {}),
    };
  });

const resolveStateDir = (
  configService: typeof ConfigService.Service,
): Effect.Effect<string | undefined, ConfigError> =>
  Effect.gen(function* () {
    const userDataRoot = yield* configService.get("userDataRoot");
    if (typeof userDataRoot !== "string" || userDataRoot.length === 0) return undefined;
    return `${userDataRoot}/providers`;
  });

interface PluginDoctorInput {
  readonly providerId: string;
  readonly platform: HostPlatform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly userDataRoot: string | undefined;
  readonly binDir: string | undefined;
  readonly stateDir: string | undefined;
}

interface PluginDoctorProvider {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
}

interface PluginDoctorCheckMapping {
  readonly report: PluginDoctorReport;
  readonly provider: PluginDoctorProvider;
  readonly selection: DoctorSelectionRecord;
}

interface PluginDoctorContributionReport {
  readonly report: PluginDoctorReport;
  readonly relevant: PluginDoctorCheckContribution["relevant"];
}

interface PluginDoctorRunOutcome {
  readonly reports: ReadonlyArray<PluginDoctorContributionReport>;
  readonly selfChecks: ReadonlyArray<DoctorSelfCheck>;
}

/**
 * Provider- and plugin-shaped probes get a tighter default than a whole report
 * section, and shrink further when the section budget is lowered.
 */
const PROBE_BUDGET_MS = 5_000;

const probeBudgetMs = (sectionBudgetMs: number): number => Math.min(PROBE_BUDGET_MS, sectionBudgetMs);

const PLUGIN_CHECK_REMEDIATION: DoctorSelfSolution = {
  kind: "manual",
  description:
    "A plugin-contributed doctor check did not complete. Remove or update the owning plugin (`lando plugin remove <name>`) if it keeps failing; the rest of this report is unaffected.",
};

const CONFIG_REMEDIATION: DoctorSelfSolution = {
  kind: "manual",
  description:
    "Lando configuration could not be read, so this input fell back to its default. Inspect it with `lando config view` and repair or remove the offending file.",
  command: "lando config view",
};

const PLUGIN_INDEX_REMEDIATION: DoctorSelfSolution = {
  kind: "manual",
  description:
    "Plugin doctor contributions could not be indexed, so no plugin checks ran. Inspect installed plugins with `lando plugin list` and remove the conflicting one.",
};

/**
 * Run every plugin-contributed doctor check under its own deadline with defect
 * capture, so a hanging or throwing contribution degrades to one attributed
 * self check instead of taking the whole doctor run down.
 */
const pluginDoctorReports = (
  modules: ReadonlyArray<LandoPluginModule>,
  input: PluginDoctorInput,
  redact: (value: string) => string,
  budgetMs: number,
): Effect.Effect<PluginDoctorRunOutcome, never> =>
  Effect.gen(function* () {
    const index = makePluginCapabilityIndex(modules);
    if (Either.isLeft(index)) {
      const described = describeDoctorFailure(index.left);
      return {
        reports: [],
        selfChecks: [
          doctorSelfCheck({
            section: "plugin-doctor-checks",
            reason: "failure",
            message: redact(described.message),
            ...(described.tag === undefined ? {} : { tag: described.tag }),
            solutions: [PLUGIN_INDEX_REMEDIATION],
          }),
        ],
      };
    }

    const isolated = yield* Effect.forEach([...index.right.doctorChecks.entries()], ([id, check]) =>
      isolateDoctorSection({
        section: `plugin-check:${id}`,
        // Suspended so a synchronous throw while *building* the effect is
        // attributed to the plugin rather than escaping the isolate.
        effect: Effect.suspend(() => check.run(input)),
        fallback: [] as ReadonlyArray<PluginDoctorReport>,
        budgetMs,
        redact,
        context: { checkId: id },
        solutions: [PLUGIN_CHECK_REMEDIATION],
      }).pipe(Effect.map((outcome) => ({ outcome, relevant: check.relevant }))),
    );

    return {
      reports: isolated.flatMap((entry) =>
        entry.outcome.value.map((report) => ({ report, relevant: entry.relevant })),
      ),
      selfChecks: isolated.flatMap((entry) => (entry.outcome.self === undefined ? [] : [entry.outcome.self])),
    };
  });

const mapPluginDoctorCheck = ({ report, provider, selection }: PluginDoctorCheckMapping): DoctorCheck => ({
  name: report.name,
  status: report.status,
  severity: report.severity,
  providerId: provider.id,
  providerName: provider.displayName,
  providerVersion: provider.version,
  providerKind: providerKindFor(provider.id),
  runtimeStatus: report.runtimeStatus ?? "unknown",
  runtime: report.runtime ?? { running: report.status === "pass" },
  capabilities: {},
  context: report.context,
  solutions: report.solutions,
  selection,
});

const setupReadinessStepContextKey = (id: string): string =>
  `step${id
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join("")}`;

const buildSetupReadinessDoctorCheck = (
  summary: SetupReadinessSummary,
  provider: { readonly id: string; readonly displayName: string; readonly version: string },
  selection?: DoctorSelectionRecord,
): DoctorCheck => {
  const failedStep = summary.steps.find((step) => step.status === "failed" || step.status === "unavailable");
  const status: DoctorStatus = summary.status === "ready" ? "pass" : "warn";
  const context: Record<string, string> = {
    providerId: provider.id,
    providerKind: providerKindFor(provider.id),
    providerVersion: provider.version,
    setupProviderId: summary.providerId,
    setupStatus: summary.status,
    updatedAt: summary.updatedAt,
  };
  if (failedStep !== undefined) context.lastFailedStep = failedStep.id;
  for (const step of summary.steps) {
    context[setupReadinessStepContextKey(step.id)] = step.status;
    if (step.status === "failed" || step.status === "unavailable")
      context[`${setupReadinessStepContextKey(step.id)}Evidence`] = step.evidence;
  }
  return {
    name: "setup-readiness",
    status,
    severity: status === "pass" ? "info" : "warn",
    providerId: provider.id,
    providerName: provider.displayName,
    providerVersion: provider.version,
    providerKind: providerKindFor(provider.id),
    runtimeStatus: summary.status,
    runtime: { running: summary.status === "ready", message: summary.status },
    capabilities: {},
    context,
    solutions:
      failedStep === undefined
        ? []
        : [
            {
              kind: "manual" as const,
              description: failedStep.remediation ?? "Rerun `lando setup` to resume host setup.",
              command: "lando setup",
            },
          ],
    ...(selection === undefined ? {} : { selection }),
  };
};

interface RuntimeServiceStatusShape {
  readonly running: boolean;
  readonly socketReachable: boolean;
  readonly pid?: number;
  readonly ownedServiceProcess: boolean;
  readonly orphanPids?: ReadonlyArray<number>;
}

interface RuntimeServiceCapableProvider {
  readonly getRuntimeServiceStatus?: Effect.Effect<RuntimeServiceStatusShape, unknown>;
}

interface ContainerDiedEventCapableProvider {
  readonly id: string;
  readonly getContainerDiedEvents?: Effect.Effect<ReadonlyArray<unknown>, unknown>;
}

const runtimeServiceStatusFromProviderStatus = (status: {
  readonly running: boolean;
}): RuntimeServiceStatusShape => ({
  running: status.running,
  socketReachable: status.running,
  ownedServiceProcess: false,
});

const runtimeServiceStatusFor = (
  provider: {
    readonly getStatus: Effect.Effect<{ readonly running: boolean }, ProviderError>;
  },
  status: { readonly running: boolean },
): Effect.Effect<RuntimeServiceStatusShape> => {
  const candidate = (provider as RuntimeServiceCapableProvider).getRuntimeServiceStatus;
  const fallback = Effect.succeed(runtimeServiceStatusFromProviderStatus(status));
  if (candidate !== undefined) return candidate.pipe(Effect.catchAll(() => fallback));
  return fallback;
};

const containerDiedEventPayloadsFor = (
  provider: ContainerDiedEventCapableProvider,
  payloads: ReadonlyArray<unknown> | undefined,
): Effect.Effect<ReadonlyArray<unknown>> => {
  if (payloads !== undefined) return Effect.succeed(payloads);
  const candidate = provider.getContainerDiedEvents;
  if (candidate !== undefined) return candidate.pipe(Effect.catchAll(() => Effect.succeed([])));
  return Effect.succeed([]);
};

const orphanRemediation = (orphanPids: ReadonlyArray<number>): DoctorSolution => ({
  kind: "manual",
  description: `Found orphaned runtime-service process(es) ${orphanPids.join(
    ",",
  )} not owned by Lando. Terminate them manually before retrying.`,
});

const buildRuntimeServiceDoctorCheck = (
  status: RuntimeServiceStatusShape,
  provider: { readonly id: string; readonly displayName: string; readonly version: string },
  runtimeVersion: string | undefined,
  readinessRuntimeService: SetupReadinessRuntimeService | undefined,
  selection?: DoctorSelectionRecord,
): DoctorCheck => {
  const hasOrphans = status.orphanPids !== undefined && status.orphanPids.length > 0;
  const checkStatus: DoctorStatus = status.running && !hasOrphans ? "pass" : "warn";
  const severity: DoctorSeverity = checkStatus === "pass" ? "info" : "warn";
  const context: Record<string, string> = {
    providerId: provider.id,
    providerKind: providerKindFor(provider.id),
    providerVersion: provider.version,
    runtimeRunning: String(status.running),
    socketReachable: String(status.socketReachable),
    ownedServiceProcess: String(status.ownedServiceProcess),
  };
  if (status.pid !== undefined) context.runtimePid = String(status.pid);
  if (hasOrphans) context.orphanPids = (status.orphanPids ?? []).join(",");
  if (readinessRuntimeService !== undefined) {
    context.lastRecordedRunning = String(readinessRuntimeService.running);
    context.lastRecordedSocketPath = readinessRuntimeService.socketPath;
    if (readinessRuntimeService.pid !== undefined)
      context.lastRecordedPid = String(readinessRuntimeService.pid);
    if (readinessRuntimeService.runtimeVersion !== undefined)
      context.lastRecordedRuntimeVersion = readinessRuntimeService.runtimeVersion;
  }

  return {
    name: "runtime-service",
    status: checkStatus,
    severity,
    providerId: provider.id,
    providerName: provider.displayName,
    providerVersion: provider.version,
    providerKind: providerKindFor(provider.id),
    runtimeStatus: status.running ? "running" : "stopped",
    runtime: {
      running: status.running,
      ...(runtimeVersion === undefined ? {} : { version: runtimeVersion }),
    },
    capabilities: {},
    context,
    solutions: hasOrphans ? [orphanRemediation(status.orphanPids ?? [])] : [],
    ...(selection === undefined ? {} : { selection }),
  };
};

interface ProviderStatusShape {
  readonly running: boolean;
  readonly message?: string;
}

const UNKNOWN_PROVIDER_VERSION = "unknown";

const providerStubFor = (providerId: string): PluginDoctorProvider => ({
  id: providerId,
  displayName: providerId === "podman" ? "Podman Runtime Provider" : providerId,
  version: UNKNOWN_PROVIDER_VERSION,
});

/**
 * Reported when the selected provider cannot be resolved at all. Doctor still
 * answers with the selection record that produced the unusable id, because
 * that is the evidence a user needs to correct it.
 */
const providerUnavailableCheck = (input: {
  readonly providerId: string;
  readonly platform: HostPlatform;
  readonly selection: DoctorSelectionRecord;
  readonly cause: unknown;
  readonly redact: (value: string) => string;
}): DoctorCheck => {
  const providerKind = providerKindFor(input.providerId);
  const described = describeDoctorFailure(input.cause);
  const message = input.redact(described.message);
  const context: Record<string, string> = {
    providerId: input.providerId,
    providerKind,
    providerVersion: UNKNOWN_PROVIDER_VERSION,
    runtimeStatus: "unavailable",
    platform: input.platform,
    selectionSource: input.selection.source,
    message,
  };
  if (described.tag !== undefined) context.failure = described.tag;
  return {
    name: "selected-provider",
    status: "fail",
    severity: "error",
    providerId: input.providerId,
    providerName: providerStubFor(input.providerId).displayName,
    providerVersion: UNKNOWN_PROVIDER_VERSION,
    providerKind,
    runtimeStatus: "unavailable",
    runtime: { running: false, message },
    capabilities: {},
    context,
    solutions: [SETUP_REMEDIATION],
    selection: input.selection,
  };
};

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
      const described = describeDoctorFailure(cause);
      selfChecks.push(
        doctorSelfCheck({
          section,
          reason: "failure",
          message: redact(described.message),
          ...(described.tag === undefined ? {} : { tag: described.tag }),
          solutions: [CONFIG_REMEDIATION],
        }),
      );
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
      redact,
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
        // Capability-gated contributions cannot be evaluated without a provider.
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
    const statusProbe = statusOutcome.self?.reason;
    const status: ProviderStatusShape = statusOutcome.value ?? { running: false };
    const versions = yield* provider.getVersions.pipe(Effect.catchAll(() => Effect.succeed(undefined)));

    const capabilities: Record<string, unknown> = {};
    for (const field of CAPABILITY_FIELDS) {
      if (provider.capabilities[field] === undefined) continue;
      capabilities[field] = provider.capabilities[field];
    }

    const runtimeMessage =
      statusProbe === undefined
        ? (status.message ?? (status.running ? "running" : "stopped"))
        : statusProbe === "timeout"
          ? "unreachable (status probe timed out)"
          : "unknown (status probe failed)";
    const runtime: DoctorRuntime = {
      running: status.running,
      ...(status.message === undefined ? {} : { message: status.message }),
      ...(versions?.runtime === undefined ? {} : { version: versions.runtime }),
    };

    const providerKind = providerKindFor(provider.id);
    const context: Record<string, string> = {
      providerId: provider.id,
      providerKind,
      providerVersion: provider.version,
      runtimeStatus: runtimeMessage,
      platform: provider.platform,
      selectionSource: resolution.source,
    };
    if (versions?.runtime !== undefined) context.runtimeVersion = versions.runtime;
    if (versions?.bundle !== undefined) context.bundleVersion = versions.bundle;
    if (statusProbe !== undefined) context.statusProbe = statusProbe;

    const statusKnown = statusProbe === undefined;
    const checkStatus: DoctorStatus = statusKnown ? (status.running ? "pass" : "warn") : "fail";
    const severity: DoctorSeverity = statusKnown ? (status.running ? "info" : "warn") : "error";
    const solutions: ReadonlyArray<DoctorSolution> = statusKnown && status.running ? [] : [SETUP_REMEDIATION];

    const primaryCheck: DoctorCheck = {
      name: "selected-provider",
      status: checkStatus,
      severity,
      providerId: provider.id,
      providerName: provider.displayName,
      providerVersion: provider.version,
      providerKind,
      runtimeStatus: runtimeMessage,
      runtime,
      capabilities,
      context,
      solutions,
      selection,
    };

    const pluginChecks = reports
      .filter((entry) => entry.relevant === undefined || entry.relevant(provider.capabilities))
      .map((entry) => mapPluginDoctorCheck({ report: entry.report, provider, selection }));
    const setupReadinessOutcome = yield* isolateDoctorSection({
      section: "setup-readiness",
      effect: readSetupReadiness(userDataRoot),
      fallback: undefined as SetupReadinessSummary | undefined,
      redact,
    });
    if (setupReadinessOutcome.self !== undefined) selfChecks.push(setupReadinessOutcome.self);
    const setupReadiness = setupReadinessOutcome.value;
    const setupReadinessChecks: ReadonlyArray<DoctorCheck> =
      setupReadiness === undefined
        ? []
        : [buildSetupReadinessDoctorCheck(setupReadiness, provider, selection)];

    const runtimeServiceChecks: ReadonlyArray<DoctorCheck> =
      providerKindFor(provider.id) === "managed"
        ? yield* Effect.gen(function* () {
            const runtimeServiceStatus = yield* runtimeServiceStatusFor(provider, status);
            return [
              buildRuntimeServiceDoctorCheck(
                runtimeServiceStatus,
                provider,
                versions?.runtime,
                setupReadiness?.runtimeService,
                selection,
              ),
            ] as ReadonlyArray<DoctorCheck>;
          })
        : [];

    const oomChecks = collectOomDoctorChecks(
      yield* containerDiedEventPayloadsFor(
        provider as ContainerDiedEventCapableProvider,
        options.diedEventPayloads,
      ),
      {
        provider,
        providerKind,
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
        providerKind,
        runtimeStatus: runtimeMessage,
        runtime,
        selection,
        sourceEnv,
      }).pipe(Effect.provide(HostProxyDoctorFileSystemLive)),
      fallback: [] as ReadonlyArray<DoctorCheck>,
      redact,
    });
    if (hostProxyOutcome.self !== undefined) selfChecks.push(hostProxyOutcome.self);
    const hostProxyChecks = hostProxyOutcome.value;

    return withSelfChecks([
      primaryCheck,
      ...pluginChecks,
      ...setupReadinessChecks,
      ...runtimeServiceChecks,
      ...hostProxyChecks,
      ...oomChecks,
    ]);
  });

const renderCapabilityValue = (value: unknown): string => {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

export const renderSolution = (solution: DoctorSolution): string => {
  const command = solution.command === undefined ? "" : ` (${solution.command})`;
  return `solution[${solution.kind}]: ${solution.description}${command}`;
};

const renderSelectionLines = (selection: DoctorSelectionRecord): ReadonlyArray<string> => {
  const lines = [`selectionSource: ${selection.source}`];
  const { inputs } = selection;
  if (inputs.flag !== undefined) lines.push(`selectionInputFlag: ${inputs.flag}`);
  if (inputs.landofile !== undefined) lines.push(`selectionInputLandofile: ${inputs.landofile}`);
  if (inputs.env !== undefined) lines.push(`selectionInputEnv: ${inputs.env}`);
  if (inputs.config !== undefined) lines.push(`selectionInputConfig: ${inputs.config}`);
  lines.push(`selectionInputDefault: ${inputs.capabilityDefault}`);
  return lines;
};

const renderCheck = (check: DoctorCheck): ReadonlyArray<string> => {
  const lines = [
    `${check.name}: ${check.status}`,
    `severity: ${check.severity}`,
    `provider: ${check.providerId}`,
    `providerName: ${check.providerName}`,
    `providerKind: ${check.providerKind}`,
    `providerVersion: ${check.providerVersion}`,
    `runtimeStatus: ${check.runtimeStatus}`,
  ];
  if (check.runtime.version !== undefined) lines.push(`runtimeVersion: ${check.runtime.version}`);
  if (check.runtime.oomKilled === true) lines.push("oomKilled: true");
  if (check.selection !== undefined) lines.push(...renderSelectionLines(check.selection));
  // "runtime-oom" mirrors the name in doctor-oom.ts; a literal avoids a runtime import cycle.
  if (
    check.name === "setup-readiness" ||
    check.name === "runtime-service" ||
    check.name === "runtime-oom" ||
    check.name === "host-proxy-transport" ||
    check.name === "host-proxy-state" ||
    check.name === "host-proxy-allowlist"
  ) {
    for (const [field, value] of Object.entries(check.context)) {
      if (field === "providerId" || field === "providerKind" || field === "providerVersion") continue;
      lines.push(`${field}: ${value}`);
    }
  }
  for (const [field, value] of Object.entries(check.capabilities)) {
    lines.push(`${field}: ${renderCapabilityValue(value)}`);
  }
  for (const solution of check.solutions) {
    lines.push(renderSolution(solution));
  }
  return lines;
};

export const renderDoctorResult = (result: DoctorResult): string =>
  result.checks.flatMap((check) => renderCheck(check)).join("\n");

const orderCapabilityKeys = (capabilities: Readonly<Record<string, unknown>>): Record<string, unknown> => {
  const ordered: Record<string, unknown> = {};
  for (const field of CAPABILITY_FIELDS) {
    if (Object.hasOwn(capabilities, field)) ordered[field as string] = capabilities[field as string];
  }
  return ordered;
};

const CONTEXT_KEY_ORDER: ReadonlyArray<string> = [
  "providerId",
  "providerKind",
  "providerVersion",
  "setupProviderId",
  "runtimeStatus",
  "setupStatus",
  "updatedAt",
  "lastFailedStep",
  "stepProvider",
  "stepCa",
  "stepProxy",
  "stepProxyEvidence",
  "stepShell",
  "stepFileSync",
  "stepFileSyncEvidence",
  "runtimeVersion",
  "bundleVersion",
  "platform",
  "selectionSource",
  "conflictKind",
  "socketPath",
  "providerLandoStatePath",
  "runtimeRunning",
  "socketReachable",
  "ownedServiceProcess",
  "runtimePid",
  "orphanPids",
  "lastRecordedRunning",
  "lastRecordedSocketPath",
  "lastRecordedPid",
  "lastRecordedRuntimeVersion",
  "containerName",
  "image",
  "exitCode",
  "app",
  "service",
  "workerState",
  "statePath",
  "appId",
  "transport",
  "reachability",
  "endpoint",
  "containerGateway",
  "workerProviderId",
  "reason",
  "failure",
];

const orderContextKeys = (context: Readonly<Record<string, string>>): Record<string, string> =>
  orderKnownKeys(context, CONTEXT_KEY_ORDER);

const selectionEventPayload = (selection: DoctorSelectionRecord): Record<string, unknown> => ({
  providerId: selection.providerId,
  source: selection.source,
  inputs: {
    ...(selection.inputs.flag === undefined ? {} : { flag: selection.inputs.flag }),
    ...(selection.inputs.landofile === undefined ? {} : { landofile: selection.inputs.landofile }),
    ...(selection.inputs.env === undefined ? {} : { env: selection.inputs.env }),
    ...(selection.inputs.config === undefined ? {} : { config: selection.inputs.config }),
    capabilityDefault: selection.inputs.capabilityDefault,
  },
});

const checkEventPayload = (check: DoctorCheck): Record<string, unknown> => {
  const payload: Record<string, unknown> = {
    _tag: "doctor.check",
    name: check.name,
    status: check.status,
    severity: check.severity,
    providerId: check.providerId,
    providerName: check.providerName,
    providerKind: check.providerKind,
    providerVersion: check.providerVersion,
    runtime: {
      running: check.runtime.running,
      ...(check.runtime.message === undefined ? {} : { message: check.runtime.message }),
      ...(check.runtime.version === undefined ? {} : { version: check.runtime.version }),
      ...(check.runtime.oomKilled === undefined ? {} : { oomKilled: check.runtime.oomKilled }),
    },
    capabilities: orderCapabilityKeys(check.capabilities),
    context: orderContextKeys(check.context),
    solutions: check.solutions.map((solution) => ({
      kind: solution.kind,
      description: solution.description,
      ...(solution.command === undefined ? {} : { command: solution.command }),
    })),
  };
  if (check.selection !== undefined) {
    payload.selection = selectionEventPayload(check.selection);
  }
  return payload;
};

export interface DoctorNdjsonOptions {
  readonly now?: Date;
}

export const renderDoctorResultAsNdjson = (result: DoctorResult, options: DoctorNdjsonOptions = {}): string =>
  renderDoctorChecksAsNdjson({
    checks: result.checks,
    now: options.now,
    checkEventPayload,
  });
