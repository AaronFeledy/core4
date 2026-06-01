import { Effect } from "effect";

import { ScratchAppIdInvalidError, ScratchSourceUnresolvedError } from "@lando/sdk/errors";
import type {
  ScratchAppError,
  ScratchAppNotFoundError,
  ScratchIsolationConflictError,
} from "@lando/sdk/errors";
import type { IsolateMode } from "@lando/sdk/schema";
import type {
  ScratchGcOptions,
  ScratchGcReport,
  ScratchHandle,
  ScratchInfo,
  ScratchSource,
  ScratchSummary,
} from "@lando/sdk/services";
import { ScratchAppService } from "@lando/sdk/services";

import { parseAnswerFlags } from "../../recipes/prompts/index.ts";

export interface ScratchStartOptions {
  readonly fork?: boolean;
  readonly from?: string;
  readonly detach?: boolean;
  readonly name?: string;
  readonly answers?: Record<string, string>;
  readonly yes?: boolean;
  readonly nonInteractive?: boolean;
  readonly isolate?: IsolateMode;
  readonly mountCwd?: { readonly target?: string };
  readonly shareGlobalStorage?: boolean;
  readonly signal?: AbortSignal;
}

export const asIsolateMode = (value: unknown): IsolateMode | undefined =>
  value === "none" || value === "full" ? value : undefined;

const MOUNT_CWD_FLAG = "--mount-cwd";

export const normalizeScratchStartArgv = (argv: ReadonlyArray<string>): ReadonlyArray<string> =>
  argv.map((arg) => (arg === MOUNT_CWD_FLAG ? `${MOUNT_CWD_FLAG}=` : arg));

const mountCwdFromValue = (value: unknown): { readonly target?: string } | undefined => {
  if (typeof value !== "string") return undefined;
  return value.length > 0 ? { target: value } : {};
};

export interface ScratchStartResult {
  readonly handle: ScratchHandle;
  readonly detached: boolean;
  readonly rendered?: boolean;
}

export interface ScratchLogsResult {
  readonly handle: ScratchHandle;
  readonly lines: ReadonlyArray<string>;
}

export type ScratchListFormat = "json" | "table";

type ScratchStartError = ScratchSourceUnresolvedError | ScratchIsolationConflictError | ScratchAppError;
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

const signalFromInput = (input: unknown): AbortSignal | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const signal = (input as { readonly signal?: unknown }).signal;
  return signal instanceof AbortSignal ? signal : undefined;
};

export const waitForAbortSignal = (signal: AbortSignal | undefined): Effect.Effect<void> => {
  if (signal === undefined) return Effect.never;
  return Effect.async<void>((resume) => {
    if (signal.aborted) {
      resume(Effect.void);
      return;
    }
    const onAbort = () => resume(Effect.void);
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });
};

const stringArrayFlag = (flags: Record<string, unknown>, key: string): ReadonlyArray<string> => {
  const value = flags[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
};

export const scratchStartOptionsFromInput = (input: unknown): ScratchStartOptions => {
  const flags = flagsFromInput(input);
  const answers = parseAnswerFlags([
    ...stringArrayFlag(flags, "answer"),
    ...stringArrayFlag(flags, "option"),
  ]);
  const isolate = asIsolateMode(flags.isolate);
  const mountCwd = mountCwdFromValue(flags["mount-cwd"]);
  const signal = signalFromInput(input);
  return {
    fork: flags.fork === true,
    ...(typeof flags.from === "string" ? { from: flags.from } : {}),
    detach: flags.detach === true,
    ...(typeof flags.name === "string" ? { name: flags.name } : {}),
    answers,
    yes: flags.yes === true,
    nonInteractive: flags["no-interactive"] === true || flags["non-interactive"] === true,
    ...(isolate === undefined ? {} : { isolate }),
    ...(mountCwd === undefined ? {} : { mountCwd }),
    ...(flags["share-global-storage"] === true ? { shareGlobalStorage: true } : {}),
    ...(signal === undefined ? {} : { signal }),
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
    const acquireBase = {
      source: hasFork ? ({ kind: "fork" } as const) : ({ kind: "recipe", ref: from ?? "" } as const),
      ...(options.name === undefined ? {} : { name: options.name }),
      ...(options.answers === undefined ? {} : { answers: options.answers }),
      ...(options.yes === undefined ? {} : { yes: options.yes }),
      ...(options.nonInteractive === undefined ? {} : { nonInteractive: options.nonInteractive }),
      ...(options.isolate === undefined ? {} : { isolate: options.isolate }),
      ...(options.mountCwd === undefined ? {} : { mountCwd: options.mountCwd }),
      ...(options.shareGlobalStorage === undefined ? {} : { shareGlobalStorage: options.shareGlobalStorage }),
    };

    if (options.detach === true) {
      const handle = yield* Effect.scoped(service.acquire({ ...acquireBase, detached: true }));
      return { handle, detached: true };
    }

    // Foreground: hold the acquire scope open until the user signals exit; the scope's
    // destroy finalizer then tears the scratch down. Print "started" before blocking, so the
    // post-run renderer is suppressed (`rendered: true`) to avoid a duplicate line.
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* service.acquire({ ...acquireBase, detached: false });
        yield* Effect.sync(() => {
          console.log(`started: ${handle.id} (press Ctrl-C to stop and destroy)`);
        });
        yield* waitForAbortSignal(options.signal);
        return { handle, detached: false, rendered: true } satisfies ScratchStartResult;
      }),
    );
  });

export const renderScratchStartResult = (result: ScratchStartResult): string | undefined => {
  if (result.rendered === true) return undefined;
  return result.detached ? result.handle.id : `started: ${result.handle.id}`;
};

export const scratchList = (): Effect.Effect<
  ReadonlyArray<ScratchSummary>,
  ScratchAppError,
  ScratchAppService
> => Effect.flatMap(ScratchAppService, (service) => service.list());

export const scratchSourceLabel = (source: ScratchSource): string =>
  source.kind === "fork" ? "fork" : `recipe:${source.ref}`;

export const renderScratchListResult = (
  result: ReadonlyArray<ScratchSummary>,
  format: ScratchListFormat = "table",
): string => {
  if (format === "json") return JSON.stringify(result);
  if (result.length === 0) return "No scratch apps found.";
  const rows = result.map((entry) =>
    [entry.id, scratchSourceLabel(entry.source), entry.mode, entry.created, entry.status].join("\t"),
  );
  return ["ID\tSOURCE\tMODE\tCREATED\tSTATUS", ...rows].join("\n");
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

export const scratchResolve = (
  id: string,
): Effect.Effect<ScratchHandle, ScratchIdCommandError, ScratchAppService> =>
  Effect.flatMap(validateScratchId(id), (validId) =>
    Effect.flatMap(ScratchAppService, (service) => service.resolveById(validId)),
  );

export const scratchInfo = (
  id: string,
): Effect.Effect<ScratchInfo, ScratchIdCommandError, ScratchAppService> =>
  Effect.flatMap(validateScratchId(id), (validId) =>
    Effect.flatMap(ScratchAppService, (service) => service.info(validId)),
  );

const renderInfoMounts = (info: ScratchInfo): ReadonlyArray<string> => {
  if (info.mounts.length === 0) return ["mounts: (none)"];
  return [
    "mounts:",
    ...info.mounts.map((mount) => {
      const origin = mount.source === undefined ? "" : ` <- ${mount.source}`;
      const flags = mount.readOnly ? `${mount.kind},ro` : mount.kind;
      return `  ${mount.service} ${mount.target}${origin} (${flags})`;
    }),
  ];
};

const renderInfoEndpoints = (info: ScratchInfo): ReadonlyArray<string> => {
  const lines = info.endpoints.flatMap((service) =>
    service.endpoints.map((endpoint) => {
      const port = endpoint.port === undefined ? "" : `:${endpoint.port}`;
      const name = endpoint.name === undefined ? "" : ` (${endpoint.name})`;
      return `  ${service.service} ${endpoint.protocol}${port}${name}`;
    }),
  );
  return lines.length === 0 ? ["endpoints: (none)"] : ["endpoints:", ...lines];
};

const renderInfoNetwork = (info: ScratchInfo): string => {
  const parts: string[] = [];
  if (info.network.perAppBridge !== undefined) parts.push(`bridge=${info.network.perAppBridge}`);
  if (info.network.sharedNetwork !== undefined) parts.push(`shared=${info.network.sharedNetwork}`);
  return `network: ${parts.length === 0 ? "(none)" : parts.join(", ")}`;
};

export const renderScratchInfoResult = (result: ScratchInfo, format: ScratchListFormat = "table"): string => {
  if (format === "json") return JSON.stringify(result, null, 2);
  return [
    `id: ${result.id}`,
    `source: ${scratchSourceLabel(result.source)}`,
    `mode: ${result.mode}`,
    `created: ${result.created}`,
    `status: ${result.status}`,
    `root: ${result.app.root}`,
    renderInfoNetwork(result),
    ...renderInfoMounts(result),
    ...renderInfoEndpoints(result),
  ].join("\n");
};

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
  Effect.map(scratchResolve(id), (handle) => ({ handle, lines: [] }));

export const renderScratchLogsResult = (result: ScratchLogsResult): string => {
  if (result.lines.length === 0) return `${result.handle.id} (no log lines)`;
  return result.lines.join("\n");
};
