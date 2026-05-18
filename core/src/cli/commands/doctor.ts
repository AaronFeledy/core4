/**
 * `lando doctor` — host/provider diagnostics.
 *
 * Reports the selected runtime provider, its version, its socket/machine
 * status, the full §5.4 capability summary, and §10.9 solution records
 * carrying `automatic` or `manual` remediation hints when a check is not
 * passing. The command never requires app bootstrap unless app-specific
 * diagnostics are requested.
 */
import { Effect } from "effect";

import type {
  NoProviderInstalledError,
  ProviderConfigError,
  ProviderUnavailableError,
} from "@lando/sdk/errors";
import {
  ProviderCapabilities,
  type ProviderCapabilities as ProviderCapabilitiesShape,
} from "@lando/sdk/schema";
import { type ProviderError, RuntimeProviderRegistry } from "@lando/sdk/services";

type DoctorError = NoProviderInstalledError | ProviderConfigError | ProviderError | ProviderUnavailableError;

export type DoctorStatus = "pass" | "warn" | "fail";
export type DoctorSeverity = "info" | "warn" | "error";
export type DoctorSolutionKind = "automatic" | "manual";

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

export interface DoctorCheck {
  readonly name: string;
  readonly status: DoctorStatus;
  readonly severity: DoctorSeverity;
  readonly providerId: string;
  readonly providerName: string;
  readonly providerVersion: string;
  readonly runtimeStatus: string;
  readonly runtime: DoctorRuntime;
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly context: Readonly<Record<string, string>>;
  readonly solutions: ReadonlyArray<DoctorSolution>;
}

export interface DoctorResult {
  readonly checks: ReadonlyArray<DoctorCheck>;
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

export const doctor = (): Effect.Effect<DoctorResult, DoctorError, RuntimeProviderRegistry> =>
  Effect.gen(function* () {
    const registry = yield* RuntimeProviderRegistry;
    const provider = yield* registry.select();
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

    const context: Record<string, string> = {
      providerId: provider.id,
      providerVersion: provider.version,
      runtimeStatus: runtimeMessage,
      platform: provider.platform,
    };
    if (versions?.runtime !== undefined) context.runtimeVersion = versions.runtime;

    const checkStatus: DoctorStatus = status.running ? "pass" : "warn";
    const severity: DoctorSeverity = status.running ? "info" : "warn";
    const solutions: ReadonlyArray<DoctorSolution> = status.running ? [] : [SETUP_REMEDIATION];

    return {
      checks: [
        {
          name: "selected-provider",
          status: checkStatus,
          severity,
          providerId: provider.id,
          providerName: provider.displayName,
          providerVersion: provider.version,
          runtimeStatus: runtimeMessage,
          runtime,
          capabilities,
          context,
          solutions,
        },
      ],
    };
  });

const renderCapabilityValue = (value: unknown): string => {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

const renderSolution = (solution: DoctorSolution): string => {
  const command = solution.command === undefined ? "" : ` (${solution.command})`;
  return `solution[${solution.kind}]: ${solution.description}${command}`;
};

export const renderDoctorResult = (result: DoctorResult): string =>
  result.checks
    .flatMap((check) => {
      const lines = [
        `${check.name}: ${check.status}`,
        `severity: ${check.severity}`,
        `provider: ${check.providerId}`,
        `providerName: ${check.providerName}`,
        `providerVersion: ${check.providerVersion}`,
        `runtimeStatus: ${check.runtimeStatus}`,
      ];
      if (check.runtime.version !== undefined) lines.push(`runtimeVersion: ${check.runtime.version}`);
      for (const [field, value] of Object.entries(check.capabilities)) {
        lines.push(`${field}: ${renderCapabilityValue(value)}`);
      }
      for (const solution of check.solutions) {
        lines.push(renderSolution(solution));
      }
      return lines;
    })
    .join("\n");

const orderCapabilityKeys = (capabilities: Readonly<Record<string, unknown>>): Record<string, unknown> => {
  const ordered: Record<string, unknown> = {};
  for (const field of CAPABILITY_FIELDS) {
    if (Object.hasOwn(capabilities, field)) ordered[field as string] = capabilities[field as string];
  }
  return ordered;
};

const orderContextKeys = (context: Readonly<Record<string, string>>): Record<string, string> => {
  const knownOrder = ["providerId", "providerVersion", "runtimeStatus", "runtimeVersion", "platform"];
  const ordered: Record<string, string> = {};
  for (const key of knownOrder) {
    if (Object.hasOwn(context, key)) ordered[key] = context[key] as string;
  }
  for (const [key, value] of Object.entries(context)) {
    if (!Object.hasOwn(ordered, key)) ordered[key] = value;
  }
  return ordered;
};

const checkEventPayload = (check: DoctorCheck): Record<string, unknown> => ({
  _tag: "doctor.check",
  name: check.name,
  status: check.status,
  severity: check.severity,
  providerId: check.providerId,
  providerName: check.providerName,
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
});

export interface DoctorNdjsonOptions {
  readonly now?: Date;
}

/**
 * Render the doctor result as a deterministic NDJSON event stream.
 *
 * Emits, in order:
 *   1. `doctor.start` with the run timestamp
 *   2. one `doctor.check` per check, carrying severity, context, capabilities,
 *      runtime status, and solution records
 *   3. `doctor.complete` with summary counts and the same timestamp
 *
 * Designed for `--renderer=json` consumers and the named snapshot fixture
 * `meta-doctor.provider-status.ndjson`. Timestamps are injectable via
 * `options.now` so snapshots can be deterministic.
 */
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
