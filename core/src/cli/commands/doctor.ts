import { Effect, Either } from "effect";

import type {
  ConfigError,
  NoProviderInstalledError,
  ProviderConfigError,
  ProviderUnavailableError,
} from "@lando/sdk/errors";
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

import { makeLandoPaths } from "../../config/paths.ts";
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
import { HostProxyDoctorFileSystemLive } from "./doctor-host-proxy-filesystem.ts";
import { hostProxyTransportDoctorChecks } from "./doctor-host-proxy.ts";
import { orderKnownKeys, renderDoctorChecksAsNdjson } from "./doctor-ndjson.ts";
import { collectOomDoctorChecks } from "./doctor-oom.ts";
import {
  type SetupReadinessRuntimeService,
  type SetupReadinessSummary,
  readSetupReadiness,
} from "./setup-readiness.ts";

export type DoctorError =
  | ConfigError
  | NoProviderInstalledError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError;

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

const gatherSelectionInputs = (
  options: DoctorOptions,
): Effect.Effect<ProviderSelectionInputs, ConfigError, ConfigService> =>
  Effect.gen(function* () {
    const configService = yield* ConfigService;
    const configProvider = yield* configService.get("defaultProviderId");

    const flag = branded(options.flagProviderId);
    const landofile = branded(options.landofileProviderId);
    const env = readProviderEnvVar(options.env ?? process.env);
    const config = configProvider ?? undefined;
    return {
      ...(flag === undefined ? {} : { flag }),
      ...(landofile === undefined ? {} : { landofile }),
      ...(env === undefined ? {} : { env }),
      ...(config === undefined ? {} : { config }),
      capabilityDefault: CAPABILITY_DEFAULT_PROVIDER_ID,
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

const pluginDoctorReports = (
  modules: ReadonlyArray<LandoPluginModule>,
  input: PluginDoctorInput,
): Effect.Effect<ReadonlyArray<PluginDoctorContributionReport>, never> =>
  Effect.gen(function* () {
    const index = yield* Either.match(makePluginCapabilityIndex(modules), {
      onLeft: (error) => Effect.die(error),
      onRight: Effect.succeed,
    });
    return (yield* Effect.forEach([...index.doctorChecks.values()], (check) =>
      check
        .run(input)
        .pipe(Effect.map((reports) => reports.map((report) => ({ report, relevant: check.relevant })))),
    )).flat();
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

export const doctor = (
  options: DoctorOptions = {},
  modules: ReadonlyArray<LandoPluginModule> = BUNDLED_PLUGIN_MODULES,
): Effect.Effect<DoctorResult, DoctorError, ConfigService | RuntimeProviderRegistry> =>
  Effect.gen(function* () {
    const configService = yield* ConfigService;
    const registry = yield* RuntimeProviderRegistry;
    const inputs = yield* gatherSelectionInputs(options);
    const resolution = resolveProviderSelection(inputs);
    const selection = buildSelectionRecord(resolution);
    const stateDir = yield* resolveStateDir(configService);
    const userDataRootRaw = yield* configService
      .get("userDataRoot")
      .pipe(Effect.catchAll(() => Effect.succeed(undefined)));
    const userDataRoot =
      typeof userDataRootRaw === "string" && userDataRootRaw.length > 0 ? userDataRootRaw : undefined;
    const platform = options.platform ?? platformFromProcess();
    const reports = yield* pluginDoctorReports(modules, {
      providerId: String(resolution.providerId),
      platform,
      stateDir,
      env: options.env ?? process.env,
      userDataRoot,
      binDir: userDataRoot === undefined ? undefined : makeLandoPaths({ userDataRoot }).binDir,
    });
    const preemptiveReports = reports
      .map((entry) => entry.report)
      .filter((report) => report.preempts === true);
    if (preemptiveReports.length > 0) {
      const providerId = String(resolution.providerId);
      const provider = {
        id: providerId,
        displayName: providerId === "podman" ? "Podman Runtime Provider" : providerId,
        version: preemptiveReports[0]?.context.providerVersion ?? "unknown",
      };
      return {
        checks: preemptiveReports.map((report) => mapPluginDoctorCheck({ report, provider, selection })),
      };
    }
    const provider = yield* registry.select({
      provider: resolution.providerId,
    } as never);
    const status = yield* provider.getStatus;
    const versions = yield* provider.getVersions.pipe(Effect.catchAll(() => Effect.succeed(undefined)));

    const capabilities: Record<string, unknown> = {};
    for (const field of CAPABILITY_FIELDS) {
      if (provider.capabilities[field] === undefined) continue;
      capabilities[field] = provider.capabilities[field];
    }

    const runtimeMessage = status.message ?? (status.running ? "running" : "stopped");
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

    const checkStatus: DoctorStatus = status.running ? "pass" : "warn";
    const severity: DoctorSeverity = status.running ? "info" : "warn";
    const solutions: ReadonlyArray<DoctorSolution> = status.running ? [] : [SETUP_REMEDIATION];

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
    const setupReadiness = yield* readSetupReadiness(userDataRoot);
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
    const hostProxyChecks = yield* hostProxyTransportDoctorChecks({
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
      sourceEnv: { ...(options.env ?? process.env) },
    }).pipe(Effect.provide(HostProxyDoctorFileSystemLive));

    return {
      checks: [
        primaryCheck,
        ...pluginChecks,
        ...setupReadinessChecks,
        ...runtimeServiceChecks,
        ...hostProxyChecks,
        ...oomChecks,
      ],
    };
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
