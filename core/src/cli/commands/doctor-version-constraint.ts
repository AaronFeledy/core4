import { relative } from "node:path";

import { Effect, Result, Schema } from "effect";

import { LandofileFormConflictError, LandofileNotFoundError } from "@lando/sdk/errors";

import { findDiscoveredLandofilePath, loadLandofileLayers } from "@lando/engine/services/landofile-live";
import { CORE_VERSION } from "@lando/engine/version";
import {
  VERSION_CONSTRAINT_SKIP_ENV_VAR,
  type VersionConstraintEntry,
  evaluateVersionConstraints,
  getVersionConstraintEntries,
  isVersionConstraintSkipped,
} from "@lando/landofile/version-constraint";
import { createStandaloneRedactor } from "@lando/redaction/service";
import * as StateStoreLayer from "@lando/state-store/service";
import {
  DoctorSeveritySchema,
  DoctorStatusSchema,
  failCheck,
  passCheckNamed,
  warnCheck,
} from "./doctor-check-builders";
import type { DoctorSeverity, DoctorStatus } from "./doctor-contract";

export interface AppVersionConstraintDoctorCheck {
  readonly name: "app-version-constraint";
  readonly status: DoctorStatus;
  readonly severity: DoctorSeverity;
  readonly context: Readonly<Record<string, string>>;
  readonly solutions: ReadonlyArray<{
    readonly kind: "manual";
    readonly description: string;
    readonly command?: string;
  }>;
}

export interface AppVersionConstraintDoctorResult {
  readonly checks: ReadonlyArray<AppVersionConstraintDoctorCheck>;
}

const DoctorSolutionSchema = Schema.Struct({
  kind: Schema.Literal("manual"),
  description: Schema.String,
  command: Schema.optionalKey(Schema.String),
});
const AppVersionConstraintDoctorCheckSchema = Schema.Struct({
  name: Schema.Literal("app-version-constraint"),
  status: DoctorStatusSchema,
  severity: DoctorSeveritySchema,
  context: Schema.Record(Schema.String, Schema.String),
  solutions: Schema.Array(DoctorSolutionSchema),
});
export const AppVersionConstraintDoctorResultSchema = Schema.Struct({
  checks: Schema.Array(AppVersionConstraintDoctorCheckSchema),
});

const VERSION_CONSTRAINT_SOLUTION = {
  kind: "manual",
  description:
    "Run `lando update` to install a compatible Lando version, or edit the Landofile `lando:` range.",
  command: "lando update",
} as const;

const INCLUDE_RESOLUTION_SOLUTION = {
  kind: "manual",
  description: "Resolve Landofile include errors before trusting the app version-constraint report.",
  command: "lando app:includes:update",
} as const;

const MALFORMED_LANDOFILE_SOLUTION = {
  kind: "manual",
  description: "Fix the Landofile syntax or `lando:` range, then rerun `lando doctor --app`.",
} as const;

const failedLoadResult = (
  context: Readonly<Record<string, string>>,
  solutions: AppVersionConstraintDoctorCheck["solutions"],
): AppVersionConstraintDoctorResult => ({
  checks: [
    failCheck({
      name: "app-version-constraint",
      context: {
        runningVersion: CORE_VERSION,
        skipped: String(isVersionConstraintSkipped(process.env)),
        ...context,
      },
      solutions,
    }),
  ],
});

const relativeSource = (appRoot: string, source: string): string => {
  if (source === ".lando.yml") return source;
  const relativePath = relative(appRoot, source);
  return relativePath === "" || relativePath.startsWith("..") ? source : relativePath;
};

const formatConstraintEntry = (
  entry: VersionConstraintEntry,
  appRoot: string,
  redact: (value: string) => string,
): string =>
  `${redact(entry.range)} (${entry.layer}#${entry.order}: ${relativeSource(appRoot, entry.source)})`;

export const appVersionConstraintsForReport = Effect.fnUntraced(function* (): Effect.fn.Return<
  AppVersionConstraintDoctorResult | undefined,
  never,
  never
> {
  const cwd = process.cwd();
  const redactor = createStandaloneRedactor("secrets", { sourceEnv: { ...process.env } });
  const redact = redactor.redactString;
  const discovery = yield* Effect.result(
    Effect.tryPromise({
      try: () => findDiscoveredLandofilePath(cwd),
      catch: (cause) => cause,
    }),
  );
  if (Result.isFailure(discovery)) {
    if (Schema.is(LandofileNotFoundError)(discovery.failure)) return undefined;
    if (Schema.is(LandofileFormConflictError)(discovery.failure)) {
      return failedLoadResult(
        {
          declared: "(conflicting Landofile forms)",
          layer: redact(discovery.failure.layer),
          loadFailure: redact(discovery.failure.message),
        },
        [{ kind: "manual", description: redact(discovery.failure.remediation) }],
      );
    }
    return yield* Effect.die(discovery.failure);
  }
  const discovered = discovery.success;
  const { appRoot, filePath } = discovered;
  const resolved = yield* Effect.result(
    loadLandofileLayers(appRoot, filePath).pipe(Effect.provide(StateStoreLayer.layer)),
  );
  if (Result.isFailure(resolved)) {
    if (resolved.failure._tag === "LandofileParseError") {
      return failedLoadResult(
        {
          declared: "(malformed Landofile)",
          loadFailure: redact(resolved.failure.message),
        },
        [MALFORMED_LANDOFILE_SOLUTION],
      );
    }
    if (resolved.failure._tag === "LandofileFormConflictError") {
      return failedLoadResult(
        {
          declared: "(conflicting Landofile forms)",
          layer: redact(resolved.failure.layer),
          loadFailure: redact(resolved.failure.message),
        },
        [{ kind: "manual", description: redact(resolved.failure.remediation) }],
      );
    }
    if (
      resolved.failure._tag === "LandofileIncludeError" ||
      resolved.failure._tag === "LandofileLockMismatchError"
    ) {
      return failedLoadResult(
        {
          declared: "(unresolved includes)",
          includeResolution: redact(resolved.failure.message),
        },
        [INCLUDE_RESOLUTION_SOLUTION],
      );
    }
    return undefined;
  }
  const landofile = resolved.success;
  const entries = getVersionConstraintEntries(landofile, filePath);
  const skipped = isVersionConstraintSkipped(process.env);
  if (entries.length === 0 && !skipped) return undefined;

  const evaluation = evaluateVersionConstraints(entries, CORE_VERSION);
  const invalid = evaluation.invalid.map((entry) => formatConstraintEntry(entry, appRoot, redact));
  const unsatisfied = evaluation.unsatisfied.map((entry) => formatConstraintEntry(entry, appRoot, redact));
  const status =
    invalid.length > 0 || (unsatisfied.length > 0 && !skipped) ? "fail" : skipped ? "warn" : "pass";
  const context: Record<string, string> = {
    runningVersion: CORE_VERSION,
    skipped: String(skipped),
    declared: entries.map((entry) => formatConstraintEntry(entry, appRoot, redact)).join(", ") || "(none)",
  };
  if (invalid.length > 0) context.invalid = invalid.join(", ");
  if (unsatisfied.length > 0) context.unsatisfied = unsatisfied.join(", ");
  if (skipped) context.skipEnv = `${VERSION_CONSTRAINT_SKIP_ENV_VAR}=1 is active`;

  return {
    checks: [
      {
        pass: () => passCheckNamed({ name: "app-version-constraint", context }),
        warn: () =>
          warnCheck({ name: "app-version-constraint", context, solutions: [VERSION_CONSTRAINT_SOLUTION] }),
        fail: () =>
          failCheck({ name: "app-version-constraint", context, solutions: [VERSION_CONSTRAINT_SOLUTION] }),
      }[status](),
    ],
  } satisfies AppVersionConstraintDoctorResult;
});

export const appVersionConstraintCheckPayload = (
  check: AppVersionConstraintDoctorCheck,
): Record<string, unknown> => ({
  _tag: "doctor.check",
  name: check.name,
  status: check.status,
  severity: check.severity,
  context: check.context,
  solutions: check.solutions,
});

export const renderAppVersionConstraintResult = (result: AppVersionConstraintDoctorResult): string =>
  result.checks
    .flatMap((check) => {
      const lines = [`${check.name}: ${check.status}`, `severity: ${check.severity}`];
      for (const [field, value] of Object.entries(check.context)) lines.push(`${field}: ${value}`);
      for (const solution of check.solutions) {
        lines.push(`solution[${solution.kind}]: ${solution.description}`);
        if (solution.command !== undefined) lines.push(`  command: ${solution.command}`);
      }
      return lines;
    })
    .join("\n");
