import { Effect } from "effect";

import { ScratchAppIdInvalidError, ScratchSourceUnresolvedError } from "@lando/sdk/errors";
import type { ScratchAppError, ScratchAppNotFoundError } from "@lando/sdk/errors";
import type { ScratchGcOptions, ScratchGcReport, ScratchHandle, ScratchSummary } from "@lando/sdk/services";
import { ScratchAppService } from "@lando/sdk/services";

export interface ScratchStartOptions {
  readonly fork?: boolean;
  readonly from?: string;
  readonly detach?: boolean;
  readonly name?: string;
}

export interface ScratchStartResult {
  readonly handle: ScratchHandle;
  readonly detached: boolean;
}

export interface ScratchLogsResult {
  readonly handle: ScratchHandle;
  readonly lines: ReadonlyArray<string>;
}

export type ScratchListFormat = "json" | "table";

type ScratchStartError = ScratchSourceUnresolvedError | ScratchAppError;
type ScratchIdCommandError = ScratchAppIdInvalidError | ScratchAppNotFoundError | ScratchAppError;

const flagsFromInput = (input: unknown): Record<string, unknown> => {
  if (typeof input !== "object" || input === null) return {};
  return (input as { readonly flags?: Record<string, unknown> }).flags ?? {};
};

const argsFromInput = (input: unknown): Record<string, unknown> => {
  if (typeof input !== "object" || input === null) return {};
  return (input as { readonly args?: Record<string, unknown> }).args ?? {};
};

const rendererModeFromInput = (input: unknown): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const rendererMode = (input as { readonly rendererMode?: unknown }).rendererMode;
  return typeof rendererMode === "string" ? rendererMode : undefined;
};

export const scratchStartOptionsFromInput = (input: unknown): ScratchStartOptions => {
  const flags = flagsFromInput(input);
  return {
    fork: flags.fork === true,
    ...(typeof flags.from === "string" ? { from: flags.from } : {}),
    detach: flags.detach === true,
    ...(typeof flags.name === "string" ? { name: flags.name } : {}),
  };
};

export const scratchIdFromInput = (input: unknown): string => {
  const id = argsFromInput(input).id;
  return typeof id === "string" ? id : "";
};

export const scratchListFormatFromInput = (input: unknown): ScratchListFormat => {
  const flags = flagsFromInput(input);
  if (flags.format === "json" || rendererModeFromInput(input) === "json") return "json";
  return "table";
};

const unresolvedSource = (message: string, source: string): ScratchSourceUnresolvedError =>
  new ScratchSourceUnresolvedError({
    message,
    source,
    attempts: [],
    remediation: "Pass exactly one of --fork or --from <recipe-ref>.",
  });

const validateScratchId = (id: string): Effect.Effect<string, ScratchAppIdInvalidError> => {
  if (id.trim().length > 0) return Effect.succeed(id);
  return Effect.fail(
    new ScratchAppIdInvalidError({
      message: "A scratch app id is required.",
      id,
      remediation: "Pass a scratch id, e.g. `lando apps:scratch:info scratch-my-app-abc123`.",
    }),
  );
};

export const scratchStart = (
  options: ScratchStartOptions = {},
): Effect.Effect<ScratchStartResult, ScratchStartError, ScratchAppService> =>
  Effect.gen(function* () {
    const hasFork = options.fork === true;
    const from = options.from?.trim();
    const hasRecipe = from !== undefined && from.length > 0;

    if (hasFork === hasRecipe) {
      const source = hasFork && hasRecipe ? `fork+recipe:${from}` : "none";
      return yield* Effect.fail(
        unresolvedSource("apps:scratch:start requires exactly one of --fork or --from <recipe-ref>.", source),
      );
    }

    const service = yield* ScratchAppService;
    const handle = yield* Effect.scoped(
      service.acquire({
        source: hasFork ? { kind: "fork" } : { kind: "recipe", ref: from ?? "" },
        detached: options.detach === true,
        ...(options.name === undefined ? {} : { name: options.name }),
      }),
    );
    return { handle, detached: options.detach === true };
  });

export const renderScratchStartResult = (result: ScratchStartResult): string =>
  result.detached ? result.handle.id : `started: ${result.handle.id}`;

export const scratchList = (): Effect.Effect<
  ReadonlyArray<ScratchSummary>,
  ScratchAppError,
  ScratchAppService
> => Effect.flatMap(ScratchAppService, (service) => service.list());

export const renderScratchListResult = (
  result: ReadonlyArray<ScratchSummary>,
  format: ScratchListFormat = "table",
): string => {
  if (format === "json") return JSON.stringify(result);
  if (result.length === 0) return "No scratch apps found.";
  const rows = result.map((entry) => `${entry.id}\t${entry.app.root}`);
  return ["ID\tROOT", ...rows].join("\n");
};

export const scratchGc = (
  options: ScratchGcOptions = {},
): Effect.Effect<ScratchGcReport, ScratchAppError, ScratchAppService> =>
  Effect.flatMap(ScratchAppService, (service) => service.gc(options));

export const renderScratchGcReport = (report: ScratchGcReport): string =>
  [
    `inspected: ${report.inspected}`,
    `reaped: ${report.reaped.length}`,
    `errors: ${report.errors.length}`,
  ].join("\n");

export const scratchInfo = (
  id: string,
): Effect.Effect<ScratchHandle, ScratchIdCommandError, ScratchAppService> =>
  Effect.flatMap(validateScratchId(id), (validId) =>
    Effect.flatMap(ScratchAppService, (service) => service.resolveById(validId)),
  );

export const renderScratchInfoResult = (result: ScratchHandle): string =>
  JSON.stringify({ id: result.id, app: result.app }, null, 2);

export const scratchStop = (
  id: string,
): Effect.Effect<ScratchHandle, ScratchIdCommandError, ScratchAppService> =>
  Effect.flatMap(validateScratchId(id), (validId) =>
    Effect.flatMap(ScratchAppService, (service) => service.stop(validId)),
  );

export const renderScratchStopResult = (result: ScratchHandle): string => `stopped: ${result.id}`;

export const scratchDestroy = (
  id: string,
  options: { readonly keepVolumes?: boolean } = {},
): Effect.Effect<ScratchHandle, ScratchIdCommandError, ScratchAppService> =>
  Effect.flatMap(validateScratchId(id), (validId) =>
    Effect.flatMap(ScratchAppService, (service) => service.destroy(validId, options)),
  );

export const renderScratchDestroyResult = (result: ScratchHandle): string => `destroyed: ${result.id}`;

export const scratchLogs = (
  id: string,
): Effect.Effect<ScratchLogsResult, ScratchIdCommandError, ScratchAppService> =>
  Effect.map(scratchInfo(id), (handle) => ({ handle, lines: [] }));

export const renderScratchLogsResult = (result: ScratchLogsResult): string => {
  if (result.lines.length === 0) return `${result.handle.id} (no log lines)`;
  return result.lines.join("\n");
};
