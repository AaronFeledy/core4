import { dirname } from "node:path";

import { Effect, Schema } from "effect";

import { LandofileNotFoundError, LandofileParseError, type NotImplementedError } from "@lando/sdk/errors";
import type { LandofileIncludeError, LandofileLockMismatchError } from "@lando/sdk/errors";
import { LandofileShape } from "@lando/sdk/schema";

import { findLandofilePath } from "../../landofile/discovery.ts";
import {
  type IncludeVerifyReport,
  type IncludeVerifyStatus,
  type LandofileIncludeDeps,
  verifyLandofileIncludes,
} from "../../landofile/includes.ts";
import { parseLandofile } from "../../landofile/parser.ts";
import { rejectBetaToolingFeatures } from "../../landofile/tooling-beta.ts";

export type {
  IncludeVerifyEntry,
  IncludeVerifyMismatch,
  IncludeVerifyReport,
  IncludeVerifyStatus,
} from "../../landofile/includes.ts";

export type AppIncludesVerifyFormat = "text" | "json";

export interface AppIncludesVerifyOptions {
  readonly cwd?: string;
  readonly deps?: LandofileIncludeDeps;
}

export type AppIncludesVerifyError =
  | LandofileNotFoundError
  | LandofileParseError
  | NotImplementedError
  | LandofileIncludeError
  | LandofileLockMismatchError;

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
    const parsed = yield* parseLandofile({ file: filePath, content, cwd: appRoot });
    yield* rejectBetaToolingFeatures(filePath, parsed);
    const decoded = decodeLandofile(parsed, { onExcessProperty: "error" });
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
 * identical across the OCLIF and compiled dispatch paths).
 */
export const renderIncludesVerifyResult = (
  report: IncludeVerifyReport,
  format: AppIncludesVerifyFormat = "text",
): string => {
  if (!report.ok) process.exitCode = 1;
  return format === "json" ? JSON.stringify(report, null, 2) : textRender(report);
};
