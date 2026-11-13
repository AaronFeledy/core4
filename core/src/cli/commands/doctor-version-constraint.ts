import { relative } from "node:path";
import { findDiscoveredLandofilePath, loadLandofileLayers } from "@lando/engine/services/landofile-live";
import { CORE_VERSION } from "@lando/engine/version";
import {
  VERSION_CONSTRAINT_SKIP_ENV_VAR,
  type VersionConstraintEntry,
  evaluateVersionConstraints,
  getVersionConstraintEntries,
  isVersionConstraintSkipped,
} from "@lando/landofile/version-constraint";
import { LandofileFormConflictError, LandofileNotFoundError } from "@lando/sdk/errors";
import * as StateStoreLayer from "@lando/state-store/service";
import { Effect, Result, Schema } from "effect";
import { CliInvocation } from "../../runtime/invocation-context";
import { failCheck, passCheckNamed, warnCheck } from "./doctor-check-builders";
import type { DoctorFinding, DoctorSectionResult, DoctorSolution } from "./doctor-contract";
import { resolveSecretsRedactor } from "./secrets-redactor";

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

const failedLoadResult = Effect.fnUntraced(function* (
  context: DoctorFinding["context"],
  solutions: ReadonlyArray<DoctorSolution>,
): Effect.fn.Return<DoctorSectionResult> {
  return {
    checks: [
      failCheck({
        name: "app-version-constraint",
        context: {
          runningVersion: CORE_VERSION,
          skipped: String(isVersionConstraintSkipped((yield* CliInvocation).env)),
          ...context,
        },
        solutions,
      }),
    ],
  };
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
  DoctorSectionResult | undefined,
  never,
  never
> {
  const { cwd, env } = yield* CliInvocation;
  const { redactor } = yield* resolveSecretsRedactor({ sourceEnv: env });
  const redact = redactor.redactString;
  const discovery = yield* Effect.result(findDiscoveredLandofilePath(cwd));
  if (Result.isFailure(discovery)) {
    if (Schema.is(LandofileNotFoundError)(discovery.failure)) return undefined;
    if (Schema.is(LandofileFormConflictError)(discovery.failure)) {
      return yield* failedLoadResult(
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
    if (resolved.failure._tag === "LandofileLoadError") {
      const { failures } = resolved.failure;
      return yield* failedLoadResult(
        {
          declared: "(Landofile load failures)",
          loadFailure: redact(resolved.failure.message),
          includeResolution: failures.map((error) => redact(error.message)),
        },
        failures.map((error) => ({ kind: "manual" as const, description: redact(error.remediation) })),
      );
    }
    if (resolved.failure._tag === "LandofileParseError") {
      return yield* failedLoadResult(
        {
          declared: "(malformed Landofile)",
          loadFailure: redact(resolved.failure.message),
        },
        [MALFORMED_LANDOFILE_SOLUTION],
      );
    }
    if (resolved.failure._tag === "LandofileFormConflictError") {
      return yield* failedLoadResult(
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
      return yield* failedLoadResult(
        {
          declared: "(unresolved includes)",
          includeResolution: [redact(resolved.failure.message)],
        },
        [INCLUDE_RESOLUTION_SOLUTION],
      );
    }
    // Any other load failure is a Landofile problem the app-config section reports; the
    // constraint was never evaluated, so it is listed as skipped rather than failed twice.
    return {
      checks: [],
      skipped: [
        {
          check: "app-version-constraint",
          reason: `The Landofile could not be loaded, so its version constraint was not evaluated: ${redact(resolved.failure.message)}`,
        },
      ],
    };
  }
  const landofile = resolved.success.document;
  const entries = getVersionConstraintEntries(landofile, filePath);
  const skipped = isVersionConstraintSkipped(env);
  if (entries.length === 0 && !skipped) return undefined;

  const evaluation = evaluateVersionConstraints(entries, CORE_VERSION);
  const invalid = evaluation.invalid.map((entry) => formatConstraintEntry(entry, appRoot, redact));
  const unsatisfied = evaluation.unsatisfied.map((entry) => formatConstraintEntry(entry, appRoot, redact));
  const context: Record<string, string | ReadonlyArray<string>> = {
    runningVersion: CORE_VERSION,
    skipped: String(skipped),
    declared: entries.map((entry) => formatConstraintEntry(entry, appRoot, redact)),
  };
  if (invalid.length > 0) context.invalid = invalid;
  if (unsatisfied.length > 0) context.unsatisfied = unsatisfied;
  if (skipped) context.skipEnv = `${VERSION_CONSTRAINT_SKIP_ENV_VAR}=1 is active`;

  if (invalid.length > 0 || (unsatisfied.length > 0 && !skipped)) {
    return {
      checks: [
        failCheck({ name: "app-version-constraint", context, solutions: [VERSION_CONSTRAINT_SOLUTION] }),
      ],
    };
  }
  if (skipped) {
    return {
      checks: [
        warnCheck({ name: "app-version-constraint", context, solutions: [VERSION_CONSTRAINT_SOLUTION] }),
      ],
    };
  }
  return { checks: [passCheckNamed({ name: "app-version-constraint", context })] };
});
