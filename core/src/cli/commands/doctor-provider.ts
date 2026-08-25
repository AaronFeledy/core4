import {
  type HostPlatform,
  ProviderCapabilities,
  type ProviderCapabilities as ProviderCapabilitiesShape,
} from "@lando/sdk/schema";

import type {
  DoctorCheck,
  DoctorRuntime,
  DoctorSelectionRecord,
  DoctorSeverity,
  DoctorSolution,
  DoctorStatus,
} from "./doctor-contract";
import { providerKindFor } from "./doctor-contract";
import type { PluginDoctorProvider } from "./doctor-plugin-checks";
import { orphanPidsFromRuntimeMessage, orphanRemediation } from "./doctor-runtime-service";
import { type DoctorSelfFailureReason, describeDoctorFailure, redactDoctorMessage } from "./doctor-self";

export interface ProviderStatusShape {
  readonly running: boolean;
  readonly message?: string;
  readonly orphanPids?: ReadonlyArray<number>;
}

export const DOCTOR_CAPABILITY_FIELDS = Object.keys(ProviderCapabilities.fields) as ReadonlyArray<
  keyof ProviderCapabilitiesShape
>;

export const SETUP_REMEDIATION: DoctorSolution = {
  kind: "manual",
  description:
    "Selected runtime provider is not running. Run `lando setup` to provision the managed runtime, then retry.",
  command: "lando setup",
};

const SYSTEM_RUNTIME_SETUP_PROVIDERS = new Set(["docker", "podman"]);

export const setupCommandForProvider = (providerId: string): string =>
  SYSTEM_RUNTIME_SETUP_PROVIDERS.has(providerId) ? `lando setup --provider=${providerId}` : "lando setup";

export const setupRemediationFor = (providerId: string): DoctorSolution => {
  if (!SYSTEM_RUNTIME_SETUP_PROVIDERS.has(providerId)) return SETUP_REMEDIATION;
  const command = setupCommandForProvider(providerId);
  return {
    kind: "manual",
    description: `Selected runtime provider is not running. Run \`${command}\` to prepare that runtime, then retry.`,
    command,
  };
};

export const UNKNOWN_PROVIDER_VERSION = "unknown";

export const providerStubFor = (providerId: string): PluginDoctorProvider => ({
  id: providerId,
  displayName: providerId === "podman" ? "Podman Runtime Provider" : providerId,
  version: UNKNOWN_PROVIDER_VERSION,
});

export const providerUnavailableCheck = (input: {
  readonly providerId: string;
  readonly platform: HostPlatform;
  readonly selection: DoctorSelectionRecord;
  readonly cause: unknown;
  readonly redact: (value: string) => string;
}): DoctorCheck => {
  const providerKind = providerKindFor(input.providerId);
  const described = describeDoctorFailure(input.cause);
  const message = redactDoctorMessage(described.message, input.redact);
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
    solutions: [setupRemediationFor(input.providerId)],
    selection: input.selection,
  };
};

export interface PrimaryProviderDiagnosis {
  readonly check: DoctorCheck;
  readonly providerKind: ReturnType<typeof providerKindFor>;
  readonly runtime: DoctorRuntime;
  readonly runtimeMessage: string;
  readonly statusKnown: boolean;
}

export const diagnosePrimaryProvider = (input: {
  readonly provider: PluginDoctorProvider & {
    readonly platform: HostPlatform;
    readonly capabilities: ProviderCapabilitiesShape;
  };
  readonly status: ProviderStatusShape;
  readonly statusProbe: DoctorSelfFailureReason | undefined;
  readonly runtimeVersion: string | undefined;
  readonly bundleVersion: string | undefined;
  readonly selection: DoctorSelectionRecord;
}): PrimaryProviderDiagnosis => {
  const { provider, status, statusProbe } = input;
  const capabilities: Record<string, unknown> = {};
  for (const field of DOCTOR_CAPABILITY_FIELDS) {
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
    ...(input.runtimeVersion === undefined ? {} : { version: input.runtimeVersion }),
  };
  const providerKind = providerKindFor(provider.id);
  const context: Record<string, string> = {
    providerId: provider.id,
    providerKind,
    providerVersion: provider.version,
    runtimeStatus: runtimeMessage,
    platform: provider.platform,
    selectionSource: input.selection.source,
  };
  if (input.runtimeVersion !== undefined) context.runtimeVersion = input.runtimeVersion;
  if (input.bundleVersion !== undefined) context.bundleVersion = input.bundleVersion;
  if (statusProbe !== undefined) context.statusProbe = statusProbe;
  const orphanPids =
    status.orphanPids !== undefined && status.orphanPids.length > 0
      ? status.orphanPids
      : orphanPidsFromRuntimeMessage(status.message);
  const hasOrphans = orphanPids.length > 0;
  if (hasOrphans) context.orphanPids = orphanPids.join(",");

  const statusKnown = statusProbe === undefined;
  let checkStatus: DoctorStatus;
  let severity: DoctorSeverity;
  if (!statusKnown) {
    checkStatus = "fail";
    severity = "error";
  } else if (status.running && !hasOrphans) {
    checkStatus = "pass";
    severity = "info";
  } else {
    checkStatus = "warn";
    severity = "warn";
  }

  const solutions: DoctorSolution[] = [];
  if (hasOrphans) solutions.push(orphanRemediation(orphanPids));
  if (!(statusKnown && status.running)) solutions.push(setupRemediationFor(provider.id));

  return {
    check: {
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
      selection: input.selection,
    },
    providerKind,
    runtime,
    runtimeMessage,
    statusKnown,
  };
};
