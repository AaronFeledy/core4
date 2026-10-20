import { dirname } from "node:path";

import { Effect, Schema } from "effect";

import {
  type ComposeKeyRejectedError,
  type Lando3LandofileDetected,
  type LandofileDialectMixError,
  LandofileFormConflictError,
  type LandofileIncludeError,
  type LandofileLoadExpressionError,
  type LandofileLockMismatchError,
  LandofileNotFoundError,
  LandofileParseError,
  type LandofileSandboxError,
  type LandofileTimeoutError,
  type LandofileValidationError,
  type ManagedFileTransactionError,
  type NotImplementedError,
  type ToolingIncludeCycleError,
} from "@lando/sdk/errors";
import type { StateStore } from "@lando/sdk/services";

import { scopedLandofileRuntimeInputs, verifyLandofileIncludes } from "@lando/engine/services/landofile-live";
import { findLandofilePath } from "@lando/landofile/discovery";
import type {
  IncludeVerifyReport,
  IncludeVerifyStatus,
  LandofileIncludeDeps,
} from "@lando/landofile/includes";
import { compileLandofileRootLayers } from "@lando/landofile/root-compile";
import { validateLandofile } from "@lando/landofile/validation";
import { mergeLandofiles } from "@lando/sdk/landofile";

export type {
  IncludeVerifyEntry,
  IncludeVerifyMismatch,
  IncludeVerifyReport,
  IncludeVerifyStatus,
} from "@lando/landofile/includes";

export type AppIncludesVerifyFormat = "text" | "json";

const IncludeVerifyNullableStringSchema = Schema.Union([Schema.String, Schema.Null]);

const IncludeVerifyEntrySchema = Schema.Struct({
  source: Schema.String,
  status: Schema.Union([
    Schema.Literal("ok"),
    Schema.Literal("mismatch"),
    Schema.Literal("missing"),
    Schema.Literal("stale"),
  ]),
  expected: IncludeVerifyNullableStringSchema,
  actual: IncludeVerifyNullableStringSchema,
});

const IncludeVerifyMismatchSchema = Schema.Struct({
  _tag: Schema.Literal("LandofileLockMismatchError"),
  message: Schema.String,
  lockfile: Schema.String,
  source: Schema.String,
  expected: Schema.String,
  actual: Schema.String,
  remediation: Schema.String,
});

export const AppIncludesVerifyResultSchema = Schema.Struct({
  lockfilePath: Schema.String,
  entries: Schema.Array(IncludeVerifyEntrySchema),
  mismatches: Schema.Array(IncludeVerifyMismatchSchema),
  ok: Schema.Boolean,
});

export interface AppIncludesVerifyOptions {
  readonly cwd?: string;
  readonly deps?: LandofileIncludeDeps;
}

export type AppIncludesVerifyError =
  | Lando3LandofileDetected
  | LandofileDialectMixError
  | LandofileFormConflictError
  | ManagedFileTransactionError
  | LandofileSandboxError
  | LandofileTimeoutError
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileValidationError
  | NotImplementedError
  | LandofileIncludeError
  | LandofileLockMismatchError
  | ToolingIncludeCycleError
  | ComposeKeyRejectedError
  | LandofileLoadExpressionError;

/**
 * Read-only check that the current app's `.lando.lock.yml` pins every remote
 * include and that the pinned content matches. Discovers + parses the Landofile directly (no
 * `LandofileService`) so the command runs at the `minimal` bootstrap level, then
 * delegates to {@link verifyLandofileIncludes}, which never mutates the lockfile.
 */
export const appIncludesVerify = Effect.fn("AppIncludesVerify.verify")(function* (
  options: AppIncludesVerifyOptions = {},
): Effect.fn.Return<IncludeVerifyReport, AppIncludesVerifyError, StateStore> {
  const cwd = options.cwd ?? process.cwd();
  const filePath = yield* Effect.tryPromise({
    try: () => findLandofilePath(cwd),
    catch: (cause) =>
      cause instanceof LandofileFormConflictError
        ? cause
        : new LandofileParseError({
            message: cause instanceof Error ? cause.message : "Failed to discover Landofile.",
            filePath: cwd,
            line: undefined,
            column: undefined,
            cause,
          }),
  });
  if (filePath === undefined) {
    return yield* Effect.fail(
      new LandofileNotFoundError({
        message: "No .lando.yml found. Run `lando init` to create one before verifying includes.",
        cwd,
      }),
    );
  }
  const appRoot = dirname(filePath);
  const inputs = yield* scopedLandofileRuntimeInputs;
  const { compiled, scope: loadScope } = yield* compileLandofileRootLayers(appRoot, filePath, inputs);
  const includes = [];
  const composeIncludes: string[] = [];
  for (const { layer, landofile: overlay } of compiled) {
    const landofile = yield* validateLandofile(layer.filePath, mergeLandofiles([overlay]));
    includes.push(...(landofile.includes ?? []));
    composeIncludes.push(...(landofile.include ?? []));
  }
  return yield* verifyLandofileIncludes({
    landofile: { includes, include: composeIncludes },
    loadScope,
    appRoot,
    ...(options.deps === undefined ? {} : { deps: options.deps }),
  });
});

const summaryLine = (report: IncludeVerifyReport): string => {
  const counts: Record<IncludeVerifyStatus, number> = { ok: 0, mismatch: 0, missing: 0, stale: 0 };
  for (const entry of report.entries) counts[entry.status] += 1;
  const verb = report.ok ? "verified" : "found drift in";
  const parts = [
    `${counts.ok} ok`,
    `${counts.mismatch} mismatch`,
    `${counts.missing} missing`,
    `${counts.stale} stale`,
  ];
  return `${report.lockfilePath}: ${verb} ${report.entries.length} include${report.entries.length === 1 ? "" : "s"} (${parts.join(", ")}).`;
};

const STATUS_GLYPH: Readonly<Record<IncludeVerifyStatus, string>> = {
  ok: "=",
  mismatch: "~",
  missing: "+",
  stale: "-",
};

export const renderIncludesVerifyResult = (
  report: IncludeVerifyReport,
  _format: AppIncludesVerifyFormat = "text",
): string => {
  const lines = [summaryLine(report)];
  for (const entry of report.entries) {
    lines.push(`  ${STATUS_GLYPH[entry.status]} ${entry.source}: ${entry.status}`);
  }
  if (report.entries.length === 0) lines.push("  (no remote includes to verify)");
  if (!report.ok) {
    lines.push(
      "Lockfile does not match the resolved includes. Run `lando app:includes:update` to refresh it.",
    );
  }
  return lines.join("\n");
};
