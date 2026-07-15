import { dirname } from "node:path";

import { Effect, Schema } from "effect";

import {
  LandofileFormConflictError,
  LandofileNotFoundError,
  LandofileParseError,
  type LandofileSandboxError,
  type LandofileTimeoutError,
  type LandofileValidationError,
  type NotImplementedError,
} from "@lando/sdk/errors";
import type { LandofileIncludeError, LandofileLockMismatchError } from "@lando/sdk/errors";

import { findLandofilePath } from "../../landofile/discovery.ts";
import {
  type IncludeUpdateReport,
  type LandofileIncludeDeps,
  updateLandofileIncludes,
} from "../../landofile/includes.ts";
import { presentLandofileLayers } from "../../landofile/layers.ts";
import { loadLandofileFile } from "../../landofile/service.ts";

export type {
  IncludeUpdateEntry,
  IncludeUpdateReport,
  IncludeUpdateStatus,
} from "../../landofile/includes.ts";

export type AppIncludesUpdateFormat = "text" | "json";

const IncludeUpdateEntrySchema = Schema.Struct({
  source: Schema.String,
  resolved: Schema.String,
  checksum: Schema.String,
  status: Schema.Union(Schema.Literal("added"), Schema.Literal("updated"), Schema.Literal("unchanged")),
});

export const AppIncludesUpdateResultSchema = Schema.Struct({
  lockfilePath: Schema.String,
  entries: Schema.Array(IncludeUpdateEntrySchema),
  removed: Schema.Array(Schema.String),
  drift: Schema.Boolean,
  wrote: Schema.Boolean,
  checkMode: Schema.Boolean,
  noNetwork: Schema.Boolean,
  requestedSources: Schema.Array(Schema.String),
});

export interface AppIncludesUpdateOptions {
  readonly check?: boolean;
  readonly cwd?: string;
  readonly deps?: LandofileIncludeDeps;
  readonly sources?: ReadonlyArray<string>;
  readonly noNetwork?: boolean;
}

export type AppIncludesUpdateError =
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileFormConflictError
  | LandofileValidationError
  | LandofileSandboxError
  | LandofileTimeoutError
  | NotImplementedError
  | LandofileIncludeError
  | LandofileLockMismatchError;

/**
 * Refresh every `includes:` lockfile entry for the current app's Landofile.
 * Discovers + parses the Landofile directly (no `LandofileService`), so the
 * command runs at the `minimal` bootstrap level and never pins against the
 * existing lock (that is exactly what `update` must override).
 */
export const appIncludesUpdate = (
  options: AppIncludesUpdateOptions = {},
): Effect.Effect<IncludeUpdateReport, AppIncludesUpdateError, never> =>
  Effect.gen(function* () {
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
          message:
            "No .lando.yml or .lando.ts found. Run `lando init` to create one before updating includes.",
          cwd,
        }),
      );
    }
    const appRoot = dirname(filePath);
    const layers = yield* Effect.tryPromise({
      try: () => presentLandofileLayers(appRoot),
      catch: (cause) =>
        cause instanceof LandofileFormConflictError
          ? cause
          : new LandofileParseError({
              message: cause instanceof Error ? cause.message : "Failed to discover Landofile layers.",
              filePath,
              line: undefined,
              column: undefined,
              cause,
            }),
    });
    const includes = [];
    for (const layer of layers) {
      const landofile = yield* loadLandofileFile(layer.filePath);
      includes.push(...(landofile.includes ?? []));
    }
    return yield* updateLandofileIncludes({
      landofile: { includes },
      appRoot,
      ...(options.check === true ? { check: true } : {}),
      ...(options.deps === undefined ? {} : { deps: options.deps }),
      ...(options.sources === undefined ? {} : { sources: options.sources }),
      ...(options.noNetwork === true ? { noNetwork: true } : {}),
    });
  });

const summaryLine = (report: IncludeUpdateReport): string => {
  const counts = { added: 0, updated: 0, unchanged: 0 };
  for (const entry of report.entries) counts[entry.status] += 1;
  const verb = report.checkMode ? "would refresh" : report.wrote ? "refreshed" : "checked";
  const parts = [`${counts.added} added`, `${counts.updated} updated`, `${counts.unchanged} unchanged`];
  if (report.removed.length > 0) parts.push(`${report.removed.length} removed`);
  const scope = report.requestedSources.length > 0 ? ` for ${report.requestedSources.join(", ")}` : "";
  const offline = report.noNetwork ? " [offline]" : "";
  return `${report.lockfilePath}: ${verb} ${report.entries.length} include${report.entries.length === 1 ? "" : "s"}${scope}${offline} (${parts.join(", ")}).`;
};

const STATUS_GLYPH: Readonly<Record<string, string>> = { added: "+", updated: "~", unchanged: "=" };

const textRender = (report: IncludeUpdateReport): string => {
  const lines = [summaryLine(report)];
  for (const entry of report.entries) {
    lines.push(`  ${STATUS_GLYPH[entry.status] ?? " "} ${entry.source} -> ${entry.resolved}`);
  }
  for (const source of report.removed) lines.push(`  - ${source} (removed)`);
  if (report.entries.length === 0 && report.removed.length === 0) {
    lines.push("  (no remote includes to lock)");
  }
  if (report.checkMode && report.drift) {
    lines.push("Lockfile is out of date. Run `lando app:includes:update` to refresh it.");
  }
  return lines.join("\n");
};

/**
 * Render an update report. In `--check` mode, sets `process.exitCode = 1` when
 * drift is detected so CI can gate on it (side-effect render pattern, identical
 * across the OCLIF and compiled dispatch paths).
 */
export const renderIncludesUpdateResult = (
  report: IncludeUpdateReport,
  _format: AppIncludesUpdateFormat = "text",
): string => {
  if (report.checkMode && report.drift) process.exitCode = 1;
  return textRender(report);
};
