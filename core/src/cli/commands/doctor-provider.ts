import {
  type HostPlatform,
  ProviderCapabilities,
  type ProviderCapabilities as ProviderCapabilitiesShape,
} from "@lando/sdk/schema";

import type { ProviderError, ProviderStatus } from "@lando/sdk/services";
import type {
  DoctorFinding,
  DoctorRuntime,
  DoctorSeverity,
  DoctorSolution,
  DoctorStatus,
} from "./doctor-contract";
import { providerKindFor } from "./doctor-contract";
import type { PluginDoctorProvider } from "./doctor-plugin-checks";
import { orphanPidsFromRuntimeMessage, orphanRemediation } from "./doctor-runtime-service";
import { type DoctorSelfFailureReason, describeDoctorFailure, redactDoctorMessage } from "./doctor-self";

export type ProviderStatusShape = ProviderStatus & {
  readonly orphanPids?: ReadonlyArray<number>;
};

const DOCTOR_CAPABILITY_FIELDS = Object.keys(ProviderCapabilities.fields) as ReadonlyArray<
  keyof ProviderCapabilitiesShape
>;

const SETUP_REMEDIATION: DoctorSolution = {
  kind: "manual",
  description:
    "Selected runtime provider is not running. Run `lando setup` to provision the managed runtime, then retry.",
  command: "lando setup",
};

const SYSTEM_RUNTIME_SETUP_PROVIDERS = new Set(["docker", "podman"]);

export const setupCommandForProvider = (providerId: string): string =>
  SYSTEM_RUNTIME_SETUP_PROVIDERS.has(providerId) ? `lando setup --provider=${providerId}` : "lando setup";

const setupRemediationFor = (providerId: string): DoctorSolution => {
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
  readonly cause: unknown;
  readonly redact: (value: string) => string;
}): DoctorFinding => {
  const described = describeDoctorFailure(input.cause);
  const message = redactDoctorMessage(described.message, input.redact);
  const context: Record<string, string | ReadonlyArray<string>> = {
    platform: input.platform,
    runtimeStatus: "unavailable",
    message,
  };
  if (described.tag !== undefined) context.failure = described.tag;
  return {
    name: "selected-provider",
    status: "fail",
    severity: "error",
    context,
    solutions: [setupRemediationFor(input.providerId)],
  };
};

interface PrimaryProviderDiagnosis {
  readonly check: DoctorFinding;
  readonly providerKind: ReturnType<typeof providerKindFor>;
  readonly runtime: DoctorRuntime;
  readonly runtimeMessage: string;
  readonly statusKnown: boolean;
  readonly capabilities: Record<string, unknown>;
}

export const diagnosePrimaryProvider = (input: {
  readonly provider: PluginDoctorProvider & {
    readonly platform: HostPlatform;
    readonly capabilities: ProviderCapabilitiesShape;
  };
  readonly status: ProviderStatusShape;
  readonly statusProbe: DoctorSelfFailureReason | undefined;
  readonly statusFailure?: ProviderError;
  readonly runtimeVersion: string | undefined;
  readonly bundleVersion: string | undefined;
}): PrimaryProviderDiagnosis => {
  const { provider, status, statusProbe } = input;
  const capabilities: Record<string, unknown> = {};
  for (const field of DOCTOR_CAPABILITY_FIELDS) {
    if (provider.capabilities[field] === undefined) continue;
    capabilities[field] = provider.capabilities[field];
  }

  const runtimeMessage =
    input.statusFailure?.message ??
    (statusProbe === undefined
      ? status.state === "idle"
        ? "idle (starts on demand)"
        : (status.message ?? "running")
      : statusProbe === "timeout"
        ? "unreachable (status probe timed out)"
        : "unknown (status probe failed)");
  const runtime: DoctorRuntime = {
    running: statusProbe === undefined && status.state === "running",
    ...(status.message === undefined ? {} : { message: status.message }),
    ...(input.runtimeVersion === undefined ? {} : { version: input.runtimeVersion }),
  };
  const providerKind = providerKindFor(provider.id);
  const context: Record<string, string | ReadonlyArray<string>> = {
    platform: provider.platform,
  };
  if (input.runtimeVersion !== undefined) context.runtimeVersion = input.runtimeVersion;
  if (input.bundleVersion !== undefined) context.bundleVersion = input.bundleVersion;
  if (statusProbe !== undefined) context.statusProbe = statusProbe;
  const orphanPids =
    status.orphanPids !== undefined && status.orphanPids.length > 0
      ? status.orphanPids
      : orphanPidsFromRuntimeMessage(status.message);
  const hasOrphans = orphanPids.length > 0;
  if (hasOrphans) context.orphanPids = orphanPids.map(String);

  const statusKnown = statusProbe === undefined;
  let checkStatus: DoctorStatus;
  let severity: DoctorSeverity;
  if (!statusKnown) {
    checkStatus = "fail";
    severity = "error";
  } else if (hasOrphans) {
    checkStatus = "warn";
    severity = "warn";
  } else {
    checkStatus = "pass";
    severity = "info";
  }

  const solutions: DoctorSolution[] = [];
  if (hasOrphans) solutions.push(orphanRemediation(orphanPids));
  if (!statusKnown)
    solutions.push(
      input.statusFailure?.remediation
        ? { kind: "manual", description: input.statusFailure.remediation }
        : setupRemediationFor(provider.id),
    );
  if (input.statusFailure !== undefined) {
    context.message = input.statusFailure.message;
    context.failure = input.statusFailure._tag;
  }

  return {
    check: {
      name: "selected-provider",
      status: checkStatus,
      severity,
      context,
      solutions,
    },
    providerKind,
    runtime,
    runtimeMessage,
    statusKnown,
    capabilities,
  };
};
