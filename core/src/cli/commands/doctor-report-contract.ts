import { Schema } from "effect";

import {
  ConfigLintResult,
  type DeprecationNotice,
  DeprecationSeverity,
  DeprecationSurfaceKind,
} from "@lando/sdk/schema";

import type { DoctorResult } from "./doctor";
import type { GlobalAppDoctorResult } from "./doctor-global-app";
import type { McpDoctorResult } from "./doctor-mcp";
import type { DoctorSelfReport } from "./doctor-self";
import { DoctorSelfReportSchema } from "./doctor-self";
import { SshAgentPostureDetails } from "./doctor-subsystem-checks";
import type { SubsystemDoctorResult } from "./doctor-subsystems";
import type { AppVersionConstraintDoctorResult } from "./doctor-version-constraint";
import { AppVersionConstraintDoctorResultSchema } from "./doctor-version-constraint";

export interface DoctorReport {
  readonly version: string;
  readonly provider: DoctorResult;
  readonly subsystems: SubsystemDoctorResult;
  readonly globalApp: GlobalAppDoctorResult;
  readonly mcp: McpDoctorResult;
  readonly appVersionConstraints?: AppVersionConstraintDoctorResult;
  readonly deprecations?: DoctorDeprecationReport;
  /** Present only under `lando doctor --app`; reuses the `app:config:lint` pass. */
  readonly appConfig?: ConfigLintResult;
  /**
   * Failures of doctor's own machinery. Present only when a report section
   * could not answer; absent on a healthy run.
   */
  readonly self?: DoctorSelfReport;
}

export interface DoctorDeprecationEntry {
  readonly kind: DeprecationSurfaceKind;
  readonly id: string;
  readonly severity: DeprecationNotice["severity"];
  readonly since: string;
  readonly removeIn?: string;
  readonly replacement?: string;
  readonly note: string;
  readonly docsUrl?: string;
  readonly source: string;
  readonly count: number;
}

export interface DoctorDeprecationReport {
  readonly entries: ReadonlyArray<DoctorDeprecationEntry>;
}

const DoctorStatusSchema = Schema.Literals(["pass", "warn", "fail"]);
const DoctorSeveritySchema = Schema.Literals(["info", "warn", "error"]);
const DoctorSolutionSchema = Schema.Struct({
  kind: Schema.Literals(["automatic", "manual"]),
  description: Schema.String,
  command: Schema.optionalKey(Schema.String),
});
const DoctorRuntimeSchema = Schema.Struct({
  running: Schema.Boolean,
  message: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String),
  oomKilled: Schema.optionalKey(Schema.Boolean),
});
const DoctorSelectionRecordSchema = Schema.Struct({
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
const DoctorCheckSchema = Schema.Struct({
  name: Schema.String,
  status: DoctorStatusSchema,
  severity: DoctorSeveritySchema,
  providerId: Schema.String,
  providerName: Schema.String,
  providerVersion: Schema.String,
  providerKind: Schema.Literals(["managed", "user-installed"]),
  runtimeStatus: Schema.String,
  runtime: DoctorRuntimeSchema,
  capabilities: Schema.Record(Schema.String, Schema.Unknown),
  context: Schema.Record(Schema.String, Schema.String),
  solutions: Schema.Array(DoctorSolutionSchema),
  selection: Schema.optionalKey(DoctorSelectionRecordSchema),
});
const DoctorResultSchema = Schema.Struct({
  checks: Schema.Array(DoctorCheckSchema),
});
const DoctorSubsystemCheckSchema = Schema.Struct({
  name: Schema.String,
  status: DoctorStatusSchema,
  severity: DoctorSeveritySchema,
  recovery: Schema.Literals(["automatic", "manual"]),
  context: Schema.Record(Schema.String, Schema.String),
  solutions: Schema.Array(DoctorSolutionSchema),
  details: Schema.optionalKey(SshAgentPostureDetails),
});
const SubsystemDoctorResultSchema = Schema.Struct({
  checks: Schema.Array(DoctorSubsystemCheckSchema),
});
const GlobalAppDoctorCheckSchema = Schema.Struct({
  name: Schema.Literal("global-app"),
  status: DoctorStatusSchema,
  severity: DoctorSeveritySchema,
  context: Schema.Record(Schema.String, Schema.String),
  solutions: Schema.Array(DoctorSolutionSchema),
});
const GlobalAppDoctorResultSchema = Schema.Struct({
  checks: Schema.Array(GlobalAppDoctorCheckSchema),
});
const McpDoctorCheckSchema = Schema.Struct({
  name: Schema.Literal("mcp"),
  status: DoctorStatusSchema,
  severity: DoctorSeveritySchema,
  context: Schema.Record(Schema.String, Schema.String),
  solutions: Schema.Array(DoctorSolutionSchema),
});
const McpDoctorResultSchema = Schema.Struct({
  checks: Schema.Array(McpDoctorCheckSchema),
});
const DoctorDeprecationEntrySchema = Schema.Struct({
  kind: DeprecationSurfaceKind,
  id: Schema.String,
  severity: DeprecationSeverity,
  since: Schema.String,
  removeIn: Schema.optionalKey(Schema.String),
  replacement: Schema.optionalKey(Schema.String),
  note: Schema.String,
  docsUrl: Schema.optionalKey(Schema.String),
  source: Schema.String,
  count: Schema.Number,
});
const DoctorDeprecationReportSchema = Schema.Struct({
  entries: Schema.Array(DoctorDeprecationEntrySchema),
});

export const DoctorReportSchema = Schema.Struct({
  version: Schema.String,
  provider: DoctorResultSchema,
  subsystems: SubsystemDoctorResultSchema,
  globalApp: GlobalAppDoctorResultSchema,
  mcp: McpDoctorResultSchema,
  appVersionConstraints: Schema.optionalKey(AppVersionConstraintDoctorResultSchema),
  deprecations: Schema.optionalKey(DoctorDeprecationReportSchema),
  appConfig: Schema.optionalKey(ConfigLintResult),
  self: Schema.optionalKey(DoctorSelfReportSchema),
});
