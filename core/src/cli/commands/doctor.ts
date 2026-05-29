import { Effect } from "effect";

import { MUTAGEN_VERSIONS_MANIFEST, readInstalledMutagenStatus } from "@lando/file-sync-mutagen";
import type { ProviderLandoStateError } from "@lando/provider-podman";
import type {
  ConfigError,
  NoProviderInstalledError,
  ProviderConfigError,
  ProviderUnavailableError,
} from "@lando/sdk/errors";
import {
  type HostPlatform,
  ProviderCapabilities,
  type ProviderCapabilities as ProviderCapabilitiesShape,
  ProviderId,
} from "@lando/sdk/schema";
import { ConfigService, type ProviderError, RuntimeProviderRegistry } from "@lando/sdk/services";

import { type ProviderConflictReport, detectProviderConflicts } from "../../providers/conflict.ts";
import {
  CAPABILITY_DEFAULT_PROVIDER_ID,
  type ProviderSelectionInputs,
  type ProviderSelectionResolution,
  type ProviderSelectionSource,
  readProviderEnvVar,
  resolveProviderSelection,
} from "../../providers/precedence.ts";

export type DoctorError =
  | ConfigError
  | NoProviderInstalledError
  | ProviderConfigError
  | ProviderError
  | ProviderLandoStateError
  | ProviderUnavailableError;

export type DoctorStatus = "pass" | "warn" | "fail";
export type DoctorSeverity = "info" | "warn" | "error";
export type DoctorSolutionKind = "automatic" | "manual";
export type DoctorProviderKind = "managed" | "user-installed";

const MANAGED_PROVIDER_IDS: ReadonlySet<string> = new Set(["lando"]);

const providerKindFor = (providerId: string): DoctorProviderKind =>
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

const conflictSolution = (conflict: ProviderConflictReport): DoctorSolution => ({
  kind: "manual",
  description: conflict.remediation,
  command: `lando setup --provider=${conflict.providerId}`,
});

const conflictCheck = (
  conflict: ProviderConflictReport,
  providerId: string,
  providerName: string,
  providerVersion: string,
  platform: HostPlatform,
  selection?: DoctorSelectionRecord,
): DoctorCheck => {
  const context: Record<string, string> = {
    providerId,
    providerKind: providerKindFor(providerId),
    providerVersion,
    runtimeStatus: "conflict",
    platform,
    conflictKind: "provider-lando-podman-socket",
  };
  if (conflict.details !== undefined) {
    const details = conflict.details;
    if (typeof details.socketPath === "string") context.socketPath = details.socketPath;
    if (typeof details.providerLandoStatePath === "string") {
      context.providerLandoStatePath = details.providerLandoStatePath;
    }
  }
  return {
    name: "provider-conflict",
    status: "warn",
    severity: "warn",
    providerId,
    providerName,
    providerVersion,
    providerKind: providerKindFor(providerId),
    runtimeStatus: "conflict",
    runtime: { running: false, message: conflict.message },
    capabilities: {},
    context,
    solutions: [conflictSolution(conflict)],
    ...(selection === undefined ? {} : { selection }),
  };
};

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

const buildFileSyncDoctorCheck = (
  provider: { readonly id: string; readonly displayName: string; readonly version: string },
  userDataRoot: string | undefined,
  selection?: DoctorSelectionRecord,
): Effect.Effect<DoctorCheck, never> =>
  Effect.gen(function* () {
    const installStatus =
      userDataRoot === undefined
        ? undefined
        : yield* Effect.promise(() => readInstalledMutagenStatus(userDataRoot));
    const installedVersion = installStatus?.installedVersion;

    const expectedVersion = MUTAGEN_VERSIONS_MANIFEST.mutagenVersion;
    const isCurrent = installStatus?.isCurrent === true;
    const checkStatus: DoctorStatus = isCurrent ? "pass" : "warn";
    const kind = providerKindFor(provider.id);

    return {
      name: "file-sync",
      status: checkStatus,
      severity: (isCurrent ? "info" : "warn") as DoctorSeverity,
      providerId: provider.id,
      providerName: provider.displayName,
      providerVersion: provider.version,
      providerKind: kind,
      runtimeStatus: installedVersion === undefined ? "not-installed" : "installed",
      runtime: {
        running: isCurrent,
        ...(installedVersion !== undefined ? { version: installedVersion } : {}),
      },
      capabilities: {},
      context: {
        engineId: "mutagen",
        mutagenVersion: installedVersion ?? "not-installed",
        expectedVersion,
      },
      solutions: isCurrent
        ? []
        : [
            {
              kind: "manual" as const,
              description: "Run `lando setup` to download the Mutagen host CLI and agent binaries.",
              command: "lando setup",
            },
          ],
      ...(selection === undefined ? {} : { selection }),
    } satisfies DoctorCheck;
  });

export const doctor = (
  options: DoctorOptions = {},
): Effect.Effect<DoctorResult, DoctorError, ConfigService | RuntimeProviderRegistry> =>
  Effect.gen(function* () {
    const configService = yield* ConfigService;
    const registry = yield* RuntimeProviderRegistry;
    const inputs = yield* gatherSelectionInputs(options);
    const resolution = resolveProviderSelection(inputs);
    const selection = buildSelectionRecord(resolution);
    const stateDir = yield* resolveStateDir(configService);
    const conflicts = yield* detectProviderConflicts({
      stateDir,
      platform: options.platform ?? platformFromProcess(),
      env: options.env ?? process.env,
    });
    if (conflicts.length > 0 && String(resolution.providerId) === "podman") {
      return {
        checks: conflicts.map((conflict) =>
          conflictCheck(
            conflict,
            String(resolution.providerId),
            "Podman Runtime Provider",
            "unknown",
            options.platform ?? platformFromProcess(),
            selection,
          ),
        ),
      };
    }
    const provider = yield* registry.select({
      provider: resolution.providerId,
    } as never);
    const status = yield* provider.getStatus;
    const versions = yield* provider.getVersions.pipe(Effect.catchAll(() => Effect.succeed(undefined)));

    const capabilities: Record<string, unknown> = {};
    for (const field of CAPABILITY_FIELDS) {
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

    const conflictChecks = conflicts.map((conflict) =>
      conflictCheck(
        conflict,
        provider.id,
        provider.displayName,
        provider.version,
        options.platform ?? provider.platform,
        selection,
      ),
    );

    const fileSyncChecks: ReadonlyArray<DoctorCheck> =
      provider.capabilities.bindMountPerformance === "slow"
        ? yield* Effect.gen(function* () {
            const userDataRootRaw = yield* configService
              .get("userDataRoot")
              .pipe(Effect.catchAll(() => Effect.succeed(undefined)));
            const userDataRoot =
              typeof userDataRootRaw === "string" && userDataRootRaw.length > 0 ? userDataRootRaw : undefined;
            const check = yield* buildFileSyncDoctorCheck(provider, userDataRoot, selection);
            return [check] as ReadonlyArray<DoctorCheck>;
          })
        : [];

    return { checks: [primaryCheck, ...conflictChecks, ...fileSyncChecks] };
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
  if (check.selection !== undefined) lines.push(...renderSelectionLines(check.selection));
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

const orderContextKeys = (context: Readonly<Record<string, string>>): Record<string, string> => {
  const knownOrder = [
    "providerId",
    "providerKind",
    "providerVersion",
    "runtimeStatus",
    "runtimeVersion",
    "bundleVersion",
    "platform",
    "selectionSource",
    "conflictKind",
    "socketPath",
    "providerLandoStatePath",
  ];
  const ordered: Record<string, string> = {};
  for (const key of knownOrder) {
    if (Object.hasOwn(context, key)) ordered[key] = context[key] as string;
  }
  for (const [key, value] of Object.entries(context)) {
    if (!Object.hasOwn(ordered, key)) ordered[key] = value;
  }
  return ordered;
};

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

export const renderDoctorResultAsNdjson = (
  result: DoctorResult,
  options: DoctorNdjsonOptions = {},
): string => {
  const timestamp = (options.now ?? new Date()).toISOString();
  const lines: string[] = [];
  lines.push(JSON.stringify({ _tag: "doctor.start", timestamp }));
  for (const check of result.checks) {
    lines.push(JSON.stringify(checkEventPayload(check)));
  }
  let failed = 0;
  let warned = 0;
  for (const check of result.checks) {
    if (check.status === "fail") failed += 1;
    else if (check.status === "warn") warned += 1;
  }
  lines.push(
    JSON.stringify({
      _tag: "doctor.complete",
      timestamp,
      checks: result.checks.length,
      failed,
      warned,
    }),
  );
  return `${lines.join("\n")}\n`;
};
