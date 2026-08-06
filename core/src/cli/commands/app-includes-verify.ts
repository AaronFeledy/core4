import { dirname } from "node:path";

import { Effect, Schema } from "effect";

import {
  type LandofileLoadExpressionError,
  LandofileNotFoundError,
  LandofileParseError,
  type NotImplementedError,
} from "@lando/sdk/errors";
import type {
  ComposeKeyRejectedError,
  LandofileIncludeError,
  LandofileLockMismatchError,
  ToolingIncludeCycleError,
} from "@lando/sdk/errors";
import { LandofileShape } from "@lando/sdk/schema";

import { rejectComposeKeys, rejectComposeTags } from "@lando/landofile/compose/rejections";
import { findLandofilePath } from "@lando/landofile/discovery";
import type {
  IncludeVerifyReport,
  IncludeVerifyStatus,
  LandofileIncludeDeps,
} from "@lando/landofile/includes";
import { parseLandofile } from "@lando/landofile/parser";
import { rejectBetaToolingFeatures } from "@lando/landofile/tooling-beta";
import { verifyLandofileIncludes } from "../../services/landofile-live.ts";

export type {
  IncludeVerifyEntry,
  IncludeVerifyMismatch,
  IncludeVerifyReport,
  IncludeVerifyStatus,
} from "@lando/landofile/includes";

export type AppIncludesVerifyFormat = "text" | "json";

const IncludeVerifyNullableStringSchema = Schema.Union(Schema.String, Schema.Literal(null));

const IncludeVerifyEntrySchema = Schema.Struct({
  source: Schema.String,
  status: Schema.Union(
    Schema.Literal("ok"),
    Schema.Literal("mismatch"),
    Schema.Literal("missing"),
    Schema.Literal("stale"),
  ),
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
  | LandofileNotFoundError
  | LandofileParseError
  | NotImplementedError
  | LandofileIncludeError
  | LandofileLockMismatchError
  | ToolingIncludeCycleError
  | ComposeKeyRejectedError
  | LandofileLoadExpressionError;

const decodeLandofile = Schema.decodeUnknownEither(LandofileShape);

/**
 * Read-only check that the current app's `.lando.lock.yml` matches its resolved
 * `includes:` tree. Discovers + parses the Landofile directly (no
 * `LandofileService`) so the command runs at the `minimal` bootstrap level, then
 * delegates to {@link verifyLandofileIncludes}, which never mutates the lockfile.
 */
export const appIncludesVerify = (
  options: AppIncludesVerifyOptions = {},
): Effect.Effect<IncludeVerifyReport, AppIncludesVerifyError, never> =>
  Effect.gen(function* () {
    const cwd = options.cwd ?? process.cwd();
    const filePath = yield* Effect.promise(() => findLandofilePath(cwd));
    if (filePath === undefined) {
      return yield* Effect.fail(
        new LandofileNotFoundError({
          message: "No .lando.yml found. Run `lando init` to create one before verifying includes.",
          cwd,
        }),
      );
    }
    const appRoot = dirname(filePath);
    const content = yield* Effect.tryPromise({
      try: () => Bun.file(filePath).text(),
      catch: (cause) =>
        new LandofileParseError({
          message: `Could not read ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}`,
          filePath,
          line: undefined,
          column: undefined,
          cause,
        }),
    });
    const checkedContent = yield* rejectComposeTags(filePath, content);
    const parsed = yield* parseLandofile({ file: filePath, content: checkedContent, cwd: appRoot });
    const checkedParsed = yield* rejectComposeKeys(filePath, parsed);
    yield* rejectBetaToolingFeatures(filePath, checkedParsed);
    const decoded = decodeLandofile(checkedParsed, { onExcessProperty: "error" });
    if (decoded._tag === "Left") {
      return yield* Effect.fail(
        new LandofileParseError({
          message: `Landofile ${filePath} is not valid: ${String(decoded.left)}`,
          filePath,
          line: undefined,
          column: undefined,
          cause: decoded.left,
        }),
      );
    }
    return yield* verifyLandofileIncludes({
      landofile: decoded.right,
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

const textRender = (report: IncludeVerifyReport): string => {
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

/**
 * Render a verify report. Sets `process.exitCode = 1` when the lockfile does not
 * match the resolved tree so CI can gate on it (side-effect render pattern,
 * identical for source and compiled entries of the native dispatcher).
 */
export const renderIncludesVerifyResult = (
  report: IncludeVerifyReport,
  _format: AppIncludesVerifyFormat = "text",
): string => {
  if (!report.ok) process.exitCode = 1;
  return textRender(report);
};
