import { relative } from "node:path";

import { Effect, Either, Schema } from "effect";

import { LandofileFormConflictError, LandofileNotFoundError } from "@lando/sdk/errors";

import {
  VERSION_CONSTRAINT_SKIP_ENV_VAR,
  type VersionConstraintEntry,
  evaluateVersionConstraints,
  getVersionConstraintEntries,
  isVersionConstraintSkipped,
} from "../../config/version-constraint.ts";
import { findDiscoveredLandofilePath, loadLandofileLayers } from "../../landofile/service.ts";
import { createStandaloneRedactor } from "../../redaction/service.ts";
import { CORE_VERSION } from "../../version.ts";

export interface AppVersionConstraintDoctorCheck {
  readonly name: "app-version-constraint";
  readonly status: "pass" | "warn" | "fail";
  readonly severity: "info" | "warn" | "error";
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

const DoctorStatusSchema = Schema.Literal("pass", "warn", "fail");
const DoctorSeveritySchema = Schema.Literal("info", "warn", "error");
const DoctorSolutionSchema = Schema.Struct({
  kind: Schema.Literal("manual"),
  description: Schema.String,
  command: Schema.optional(Schema.String),
});
const AppVersionConstraintDoctorCheckSchema = Schema.Struct({
  name: Schema.Literal("app-version-constraint"),
  status: DoctorStatusSchema,
  severity: DoctorSeveritySchema,
  context: Schema.Record({ key: Schema.String, value: Schema.String }),
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
    {
      name: "app-version-constraint",
      status: "fail",
      severity: "error",
      context: {
        runningVersion: CORE_VERSION,
        skipped: String(isVersionConstraintSkipped(process.env)),
        ...context,
      },
      solutions,
    },
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

export const appVersionConstraintsForReport = (): Effect.Effect<
  AppVersionConstraintDoctorResult | undefined,
  never,
  never
> =>
  Effect.gen(function* () {
    const cwd = process.cwd();
    const redactor = createStandaloneRedactor("secrets", { sourceEnv: { ...process.env } });
    const redact = redactor.redactString;
    const discovery = yield* Effect.either(
      Effect.tryPromise({
        try: () => findDiscoveredLandofilePath(cwd),
        catch: (cause) => cause,
      }),
    );
    if (Either.isLeft(discovery)) {
      if (Schema.is(LandofileNotFoundError)(discovery.left)) return undefined;
      if (Schema.is(LandofileFormConflictError)(discovery.left)) {
        return failedLoadResult(
          {
            declared: "(conflicting Landofile forms)",
            layer: redact(discovery.left.layer),
            loadFailure: redact(discovery.left.message),
          },
          [{ kind: "manual", description: redact(discovery.left.remediation) }],
        );
      }
      return yield* Effect.die(discovery.left);
    }
    const discovered = discovery.right;
    const { appRoot, filePath } = discovered;
    const resolved = yield* Effect.either(loadLandofileLayers(appRoot, filePath));
    if (Either.isLeft(resolved)) {
      if (resolved.left._tag === "LandofileParseError") {
        return failedLoadResult(
          {
            declared: "(malformed Landofile)",
            loadFailure: redact(resolved.left.message),
          },
          [MALFORMED_LANDOFILE_SOLUTION],
        );
      }
      if (resolved.left._tag === "LandofileFormConflictError") {
        return failedLoadResult(
          {
            declared: "(conflicting Landofile forms)",
            layer: redact(resolved.left.layer),
            loadFailure: redact(resolved.left.message),
          },
          [{ kind: "manual", description: redact(resolved.left.remediation) }],
        );
      }
      if (
        resolved.left._tag === "LandofileIncludeError" ||
        resolved.left._tag === "LandofileLockMismatchError"
      ) {
        return failedLoadResult(
          {
            declared: "(unresolved includes)",
            includeResolution: redact(resolved.left.message),
          },
          [INCLUDE_RESOLUTION_SOLUTION],
        );
      }
      return undefined;
    }
    const landofile = resolved.right;
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
          name: "app-version-constraint",
          status,
          severity: status === "pass" ? "info" : status === "warn" ? "warn" : "error",
          context,
          solutions: status === "pass" ? [] : [VERSION_CONSTRAINT_SOLUTION],
        },
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
