/**
 * The single `lando doctor` result contract.
 *
 * Every report shape is an Effect Schema; the TypeScript types are inferred.
 * Built-in producers and plugin contributions both return section-agnostic
 * `DoctorFinding`s, and the section runner stamps the report section onto them.
 */

import { ConfigError } from "@lando/sdk/errors";
import { AgentSocketDelivery, ConfigLintViolation } from "@lando/sdk/schema";
import { Schema } from "effect";

/** Report section ids in display and collection order. */
export const DOCTOR_SECTION_IDS = [
  "global-config",
  "provider",
  "app-listeners",
  "certificate-authority",
  "network-trust",
  "subsystems",
  "global-app",
  "mcp",
  "accelerated-starts",
  "missing-app-roots",
  "orphaned-volume-snapshots",
  "legacy-snapshot-catalogs",
  "filesystem-watch",
  "debugger-host",
  "app-version-constraints",
  "deprecations",
  "app-config",
] as const;

export const DOCTOR_SELF_CHECK_NAME = "doctor-self";

export const providerKindFor = (providerId: string): DoctorProviderKind =>
  providerId === "lando" ? "managed" : "user-installed";

export const DoctorStatus = Schema.Literals(["pass", "warn", "fail"]);
export type DoctorStatus = typeof DoctorStatus.Type;

export const DoctorSeverity = Schema.Literals(["info", "warn", "error"]);
export type DoctorSeverity = typeof DoctorSeverity.Type;

export const DoctorSolution = Schema.Struct({
  kind: Schema.Literals(["automatic", "manual"]),
  description: Schema.String,
  command: Schema.optionalKey(Schema.String),
});
export type DoctorSolution = typeof DoctorSolution.Type;
export type DoctorSolutionKind = DoctorSolution["kind"];

export const DoctorRuntime = Schema.Struct({
  running: Schema.Boolean,
  message: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String),
});
export type DoctorRuntime = typeof DoctorRuntime.Type;

export const DoctorSelection = Schema.Struct({
  providerId: Schema.String,
  source: Schema.Literals(["flag", "landofile", "env", "config", "default"]),
  inputs: Schema.Struct({
    flag: Schema.optionalKey(Schema.String),
    landofile: Schema.optionalKey(Schema.String),
    env: Schema.optionalKey(Schema.String),
    config: Schema.optionalKey(Schema.String),
    capabilityDefault: Schema.String,
  }),
});
export type DoctorSelection = typeof DoctorSelection.Type;

export const DoctorProviderKind = Schema.Literals(["managed", "user-installed"]);
export type DoctorProviderKind = typeof DoctorProviderKind.Type;

/**
 * The SSH-agent posture inspection result. It lives on the report contract so
 * `DoctorFinding.details` can reuse it without a copy or an import cycle.
 */
export const SshAgentPostureDetails = Schema.Struct({
  mode: Schema.Literals(["sidecar", "host"]),
  upstream: Schema.Struct({
    source: Schema.Literals([
      "sidecar",
      "explicit",
      "env",
      "1password",
      "gpg",
      "yubikey-agent",
      "windows-openssh",
      "none",
    ]),
    reachable: Schema.Boolean,
    identities: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    reason: Schema.optionalKey(Schema.String),
    socketPath: Schema.optionalKey(Schema.String),
    danglingEnvSocket: Schema.optionalKey(Schema.String),
  }),
  delivery: Schema.Union([AgentSocketDelivery, Schema.Literals(["none", "runtime-volume"])]),
  runtimeVolume: Schema.optionalKey(Schema.String),
  security: Schema.String,
  gpg: Schema.optionalKey(
    Schema.Struct({
      forward: Schema.Literal(true),
      upstream: Schema.Struct({
        source: Schema.Literals(["explicit", "gpgconf", "none"]),
        reachable: Schema.Boolean,
      }),
      keyringExported: Schema.Boolean,
      security: Schema.String,
    }),
  ),
});
export type SshAgentPostureDetails = typeof SshAgentPostureDetails.Type;

export const DoctorRecovery = Schema.Literals(["automatic", "manual"]);
export type DoctorRecovery = typeof DoctorRecovery.Type;

/**
 * What every producer returns, built-in or plugin. Field set is
 * `PluginDoctorReport` minus `preempts` (unbounded, no plugin-only union) plus
 * built-in-only optional fields.
 */
export const DoctorFinding = Schema.Struct({
  name: Schema.String,
  status: DoctorStatus,
  severity: DoctorSeverity,
  runtimeStatus: Schema.optionalKey(Schema.String),
  runtime: Schema.optionalKey(DoctorRuntime),
  context: Schema.Record(Schema.String, Schema.String),
  solutions: Schema.Array(DoctorSolution),
  /** Plugin doctor contribution id; absent for core producers. */
  contributor: Schema.optionalKey(Schema.String),
  recovery: Schema.optionalKey(DoctorRecovery),
  // A report holds data, not error instances: the boundary's redacted copy drops an
  // Error's non-enumerable `message`, so a `ConfigError` is carried in its encoded form.
  details: Schema.optionalKey(
    Schema.Union([SshAgentPostureDetails, ConfigLintViolation, Schema.toEncoded(ConfigError)]),
  ),
});
export type DoctorFinding = typeof DoctorFinding.Type;

export const DoctorSectionId = Schema.Literals(DOCTOR_SECTION_IDS);
export type DoctorSectionId = typeof DoctorSectionId.Type;

export const DoctorCheck = Schema.Struct({
  section: DoctorSectionId,
  ...DoctorFinding.fields,
});
export type DoctorCheck = typeof DoctorCheck.Type;

/** A section-local skip; the runner stamps the report section onto it. */
export const DoctorSkipInput = Schema.Struct({
  check: Schema.optionalKey(Schema.String),
  reason: Schema.String,
});
export type DoctorSkipInput = typeof DoctorSkipInput.Type;

export const DoctorSkip = Schema.Struct({
  section: DoctorSectionId,
  ...DoctorSkipInput.fields,
});
export type DoctorSkip = typeof DoctorSkip.Type;

export const DoctorSelfFailureReason = Schema.Literals(["failure", "defect", "timeout"]);
export type DoctorSelfFailureReason = typeof DoctorSelfFailureReason.Type;

/** A doctor-machinery failure, already attributed to its report section. */
export const DoctorSelfFinding = Schema.Struct({
  ...DoctorCheck.fields,
  name: Schema.Literal(DOCTOR_SELF_CHECK_NAME),
  status: Schema.Literal("fail"),
  severity: Schema.Literal("error"),
});
export type DoctorSelfFinding = typeof DoctorSelfFinding.Type;

export const DoctorProvider = Schema.Struct({
  id: Schema.String,
  kind: DoctorProviderKind,
  selection: DoctorSelection,
  name: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String),
  runtimeStatus: Schema.optionalKey(Schema.String),
  runtime: Schema.optionalKey(DoctorRuntime),
  capabilities: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export type DoctorProvider = typeof DoctorProvider.Type;

export const DoctorSectionResult = Schema.Struct({
  checks: Schema.Array(DoctorFinding),
  skipped: Schema.optionalKey(Schema.Array(DoctorSkipInput)),
  provider: Schema.optionalKey(DoctorProvider),
});
export type DoctorSectionResult = typeof DoctorSectionResult.Type;

export const DoctorSummary = Schema.Struct({
  checks: Schema.Number,
  passed: Schema.Number,
  warned: Schema.Number,
  failed: Schema.Number,
});
export type DoctorSummary = typeof DoctorSummary.Type;

export const DoctorReportSchema = Schema.Struct({
  version: Schema.String,
  provider: Schema.optionalKey(DoctorProvider),
  checks: Schema.Array(DoctorCheck),
  skipped: Schema.Array(DoctorSkip),
  summary: DoctorSummary,
});
export type DoctorReport = typeof DoctorReportSchema.Type;

/** Terminal NDJSON frame value: the report without its enumerated records. */
export const DoctorNdjsonResultSchema = Schema.Struct({
  version: Schema.String,
  provider: Schema.optionalKey(DoctorProvider),
  summary: DoctorSummary,
});
export type DoctorNdjsonResult = typeof DoctorNdjsonResultSchema.Type;
