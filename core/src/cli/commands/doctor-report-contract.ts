import { Schema } from "effect";

import {
  ConfigLintResult,
  type DeprecationNotice,
  DeprecationSeverity,
  DeprecationSurfaceKind,
} from "@lando/sdk/schema";

import type { GlobalAppDoctorResult } from "./doctor-global-app.ts";
import type { McpDoctorResult } from "./doctor-mcp.ts";
import type { SubsystemDoctorResult } from "./doctor-subsystems.ts";
import type { AppVersionConstraintDoctorResult } from "./doctor-version-constraint.ts";
import { AppVersionConstraintDoctorResultSchema } from "./doctor-version-constraint.ts";
import type { DoctorResult } from "./doctor.ts";

export interface DoctorReport {
  readonly provider: DoctorResult;
  readonly subsystems: SubsystemDoctorResult;
  readonly globalApp: GlobalAppDoctorResult;
  readonly mcp: McpDoctorResult;
  readonly appVersionConstraints?: AppVersionConstraintDoctorResult;
  readonly deprecations?: DoctorDeprecationReport;
  /** Present only under `lando doctor --app`; reuses the `app:config:lint` pass. */
  readonly appConfig?: ConfigLintResult;
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

const DoctorStatusSchema = Schema.Literal("pass", "warn", "fail");
const DoctorSeveritySchema = Schema.Literal("info", "warn", "error");
const DoctorSolutionSchema = Schema.Struct({
  kind: Schema.Literal("automatic", "manual"),
  description: Schema.String,
  command: Schema.optional(Schema.String),
});
const DoctorRuntimeSchema = Schema.Struct({
  running: Schema.Boolean,
  message: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  oomKilled: Schema.optional(Schema.Boolean),
});
const DoctorSelectionRecordSchema = Schema.Struct({
  providerId: Schema.String,
  source: Schema.Literal("flag", "landofile", "env", "config", "default"),
  inputs: Schema.Struct({
    flag: Schema.optional(Schema.String),
    landofile: Schema.optional(Schema.String),
    env: Schema.optional(Schema.String),
    config: Schema.optional(Schema.String),
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
  providerKind: Schema.Literal("managed", "user-installed"),
  runtimeStatus: Schema.String,
  runtime: DoctorRuntimeSchema,
  capabilities: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  context: Schema.Record({ key: Schema.String, value: Schema.String }),
  solutions: Schema.Array(DoctorSolutionSchema),
  selection: Schema.optional(DoctorSelectionRecordSchema),
});
const DoctorResultSchema = Schema.Struct({
  checks: Schema.Array(DoctorCheckSchema),
});
const DoctorSubsystemCheckSchema = Schema.Struct({
  name: Schema.String,
  status: DoctorStatusSchema,
  severity: DoctorSeveritySchema,
  recovery: Schema.Literal("automatic", "manual"),
  context: Schema.Record({ key: Schema.String, value: Schema.String }),
  solutions: Schema.Array(DoctorSolutionSchema),
});
const SubsystemDoctorResultSchema = Schema.Struct({
  checks: Schema.Array(DoctorSubsystemCheckSchema),
});
const GlobalAppDoctorCheckSchema = Schema.Struct({
  name: Schema.Literal("global-app"),
  status: DoctorStatusSchema,
  severity: DoctorSeveritySchema,
  context: Schema.Record({ key: Schema.String, value: Schema.String }),
  solutions: Schema.Array(DoctorSolutionSchema),
});
const GlobalAppDoctorResultSchema = Schema.Struct({
  checks: Schema.Array(GlobalAppDoctorCheckSchema),
});
const McpDoctorCheckSchema = Schema.Struct({
  name: Schema.Literal("mcp"),
  status: DoctorStatusSchema,
  severity: DoctorSeveritySchema,
  context: Schema.Record({ key: Schema.String, value: Schema.String }),
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
  removeIn: Schema.optional(Schema.String),
  replacement: Schema.optional(Schema.String),
  note: Schema.String,
  docsUrl: Schema.optional(Schema.String),
  source: Schema.String,
  count: Schema.Number,
});
const DoctorDeprecationReportSchema = Schema.Struct({
  entries: Schema.Array(DoctorDeprecationEntrySchema),
});

export const DoctorReportSchema = Schema.Struct({
  provider: DoctorResultSchema,
  subsystems: SubsystemDoctorResultSchema,
  globalApp: GlobalAppDoctorResultSchema,
  mcp: McpDoctorResultSchema,
  appVersionConstraints: Schema.optional(AppVersionConstraintDoctorResultSchema),
  deprecations: Schema.optional(DoctorDeprecationReportSchema),
  appConfig: Schema.optional(ConfigLintResult),
});
