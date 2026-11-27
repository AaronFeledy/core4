import {
  type FollowLogsAppOptions,
  type LogsAppError,
  type LogsAppResult,
  followLogsForPlan,
  logsForPlan,
  validateSince,
} from "@lando/engine/operations/logs";
import { emitOptionalStdout } from "@lando/renderer/output";
import { type SummaryDocument, formatSummary, worstSummaryTone } from "@lando/renderer/summary";
import type {
  AppPlacementError,
  AppResolveError,
  DebuggerHostUnavailableError,
  LandofileVersionConstraintError,
  NoProviderInstalledError,
  ScratchAppNotFoundError,
  ScratchIsolationConflictError,
} from "@lando/sdk/errors";
import {
  type RouteUrlBindingError,
  ScratchAppError,
  ScratchAppIdInvalidError,
  ScratchSourceUnresolvedError,
} from "@lando/sdk/errors";
import { AbsolutePath, type IsolateMode, StartAppResult } from "@lando/sdk/schema";
import type {
  ProviderError,
  ScratchGcOptions,
  ScratchGcReport,
  ScratchHandle,
  ScratchInfo,
  ScratchSource,
  ScratchSummary,
} from "@lando/sdk/services";
import { RuntimeProviderRegistry, ScratchAppService, ScratchPublishedRoute } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { mergeAnswerSources, parseAnswerFlags, readAnswersFile } from "../prompts/answer-flags";
import { type RenderContext, isDecoratedContext, summaryPaintOptions } from "../renderer-boundary";
import { extractSpecAbortSignal } from "../spec/command-base";
import { commandResultFormatAmong, specArgsOf, specFlagsOf, stringFlag } from "../spec/input-coercion";
import { renderLogsAppResult } from "./logs";
import { SCRATCH_STATUS_TONES, summaryToneFromTable } from "./service-summary";

export interface ScratchStartOptions {
  readonly fork?: boolean;
  readonly from?: string;
  readonly source?: string;
  readonly detach?: boolean;
  readonly name?: string;
  readonly answers?: Record<string, string>;
  readonly answersFile?: string;
  readonly yes?: boolean;
  readonly nonInteractive?: boolean;
  readonly isolate?: IsolateMode;
  readonly mountCwd?: { readonly target?: string };
  readonly shareGlobalStorage?: boolean;
  readonly excludes?: ReadonlyArray<string>;
  readonly keepOnFailure?: boolean;
  readonly runPostInit?: boolean;
  readonly noLocalOverrides?: boolean;
  readonly noHostnameSuffix?: boolean;
  readonly hostnames?: ReadonlyArray<string>;
  readonly signal?: AbortSignal;
}

export const asIsolateMode = (value: unknown): IsolateMode | undefined =>
  value === "none" ? "cwd" : value === "full" || value === "baked" || value === "cwd" ? value : undefined;

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

export const ScratchSourceResultSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("fork") }),
  Schema.Struct({ kind: Schema.Literal("recipe"), ref: Schema.String }),
]);

export const ScratchAppRefResultSchema = Schema.Struct({
  kind: Schema.Literals(["user", "global", "scratch"]),
  id: Schema.String,
  root: AbsolutePath,
});

export const ScratchHandleResultSchema = Schema.Struct({
  id: Schema.String,
  app: ScratchAppRefResultSchema,
  credentialChanges: StartAppResult.fields.credentialChanges,
});

export const ScratchSummaryResultSchema = Schema.Struct({
  id: Schema.String,
  app: ScratchAppRefResultSchema,
  source: ScratchSourceResultSchema,
  mode: Schema.Literals(["full", "baked", "cwd"]),
  created: Schema.String,
  status: Schema.Literals(["attached", "detached", "orphan"]),
});

export const ScratchListResultSchema = Schema.Array(ScratchSummaryResultSchema);

const ScratchMountPointResultSchema = Schema.Struct({
  service: Schema.String,
  target: Schema.String,
  source: Schema.optionalKey(Schema.String),
  kind: Schema.Literals(["app", "bind", "tmpfs", "volume"]),
  readOnly: Schema.Boolean,
});

const ScratchNetworkMembershipResultSchema = Schema.Struct({
  perAppBridge: Schema.optionalKey(Schema.String),
  sharedNetwork: Schema.optionalKey(Schema.String),
});

const ScratchEndpointResultSchema = Schema.Struct({
  protocol: Schema.String,
  port: Schema.optionalKey(Schema.Number),
  name: Schema.optionalKey(Schema.String),
});

const ScratchServiceEndpointsResultSchema = Schema.Struct({
  service: Schema.String,
  endpoints: Schema.Array(ScratchEndpointResultSchema),
});

export const ScratchInfoResultSchema = Schema.Struct({
  id: Schema.String,
  app: ScratchAppRefResultSchema,
  source: ScratchSourceResultSchema,
  mode: Schema.Literals(["full", "baked", "cwd"]),
  created: Schema.String,
  status: Schema.Literals(["attached", "detached", "orphan"]),
  mounts: Schema.Array(ScratchMountPointResultSchema),
  network: ScratchNetworkMembershipResultSchema,
  endpoints: Schema.Array(ScratchServiceEndpointsResultSchema),
  routes: Schema.optionalKey(Schema.Array(ScratchPublishedRoute)).annotate({
    description:
      "Route URLs the router confirms for this scratch. Present only when the scratch declares enabled routes; empty when none are confirmed.",
  }),
});

export const ScratchStartResultSchema = Schema.Struct({
  handle: ScratchHandleResultSchema,
  detached: Schema.Boolean,
  rendered: Schema.optionalKey(Schema.Boolean),
});

export const ScratchGcReportResultSchema = Schema.Struct({
  inspected: Schema.Number,
  candidates: Schema.Array(Schema.String),
  reaped: Schema.Array(Schema.String),
  errors: Schema.Array(Schema.String),
});

export type ScratchListFormat = "json" | "table";

type ScratchStartError =
  | RouteUrlBindingError
  | AppPlacementError
  | ScratchSourceUnresolvedError
  | ScratchIsolationConflictError
  | ScratchAppError
  | DebuggerHostUnavailableError
  | LandofileVersionConstraintError;
type ScratchIdCommandError = ScratchAppIdInvalidError | ScratchAppNotFoundError | ScratchAppError;

export const waitForAbortSignal = (signal: AbortSignal | undefined): Effect.Effect<void> => {
  if (signal === undefined) return Effect.never;
  return Effect.callback<void>((resume) => {
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
  const flags = specFlagsOf(input);
  const answers = parseAnswerFlags(
    mergeAnswerSources(stringArrayFlag(flags, "answer"), stringArrayFlag(flags, "option")),
  );
  const isolate = asIsolateMode(flags.isolate);
  const mountCwd = mountCwdFromValue(flags["mount-cwd"]);
  const signal = extractSpecAbortSignal(input);
  const excludes = stringArrayFlag(flags, "exclude");
  const hostnames = stringArrayFlag(flags, "hostname");
  return {
    fork: flags.fork === true,
    ...(typeof flags.from === "string" ? { from: flags.from } : {}),
    ...(typeof flags.source === "string" ? { source: flags.source } : {}),
    detach: flags.detach === true,
    ...(typeof flags.name === "string" ? { name: flags.name } : {}),
    answers,
    ...(typeof flags.answers === "string" ? { answersFile: flags.answers } : {}),
    yes: flags.yes === true,
    nonInteractive:
      flags.interactive === true
        ? false
        : flags["no-interactive"] === true || flags["non-interactive"] === true,
    ...(isolate === undefined ? {} : { isolate }),
    ...(mountCwd === undefined ? {} : { mountCwd }),
    ...(flags["share-global-storage"] === true ? { shareGlobalStorage: true } : {}),
    ...(excludes.length === 0 ? {} : { excludes }),
    ...(flags["keep-on-failure"] === true ? { keepOnFailure: true } : {}),
    ...(flags["run-post-init"] === true ? { runPostInit: true } : {}),
    ...(flags["no-local-overrides"] === true ? { noLocalOverrides: true } : {}),
    ...(flags["no-hostname-suffix"] === true ? { noHostnameSuffix: true } : {}),
    ...(hostnames.length === 0 ? {} : { hostnames }),
    ...(signal === undefined ? {} : { signal }),
  };
};

export const scratchIdFromInput = (input: unknown): string => stringFlag(specArgsOf(input), "id") ?? "";

export const scratchListFormatFromInput = (input: unknown): ScratchListFormat =>
  commandResultFormatAmong(input, ["json", "table"], "table");

const unresolvedSource = (
  message: string,
  source: string,
  remediation = "Pass exactly one of --fork or --from <recipe-ref>.",
): ScratchSourceUnresolvedError =>
  new ScratchSourceUnresolvedError({
    message,
    source,
    attempts: [],
    remediation,
  });

const validateScratchId = (id: string): Effect.Effect<string, ScratchAppIdInvalidError> => {
  if (id.trim().length > 0) return Effect.succeed(id);
  return Effect.fail(
    new ScratchAppIdInvalidError({
      message: "A scratch app id or name is required.",
      id,
      remediation:
        "Pass a scratch id or the --name it was started with, e.g. `lando apps:scratch:info scratch-my-app-abc123`.",
    }),
  );
};

export const scratchStart = Effect.fn("Scratch.start")(function* (
  options: ScratchStartOptions = {},
): Effect.fn.Return<ScratchStartResult, ScratchStartError, ScratchAppService> {
  const hasFork = options.fork === true;
  const from = options.from?.trim();
  const hasRecipe = from !== undefined && from.length > 0;

  if (!hasFork && options.source !== undefined) {
    return yield* unresolvedSource(
      "apps:scratch:start --source <path> requires --fork.",
      hasRecipe ? `recipe:${from}` : "none",
      "Pass --fork with --source <path>, or drop --source.",
    );
  }
  if (hasFork === hasRecipe) {
    const source = hasFork && hasRecipe ? `fork+recipe:${from}` : "none";
    return yield* unresolvedSource(
      "apps:scratch:start requires exactly one of --fork or --from <recipe-ref>.",
      source,
    );
  }

  const service = yield* ScratchAppService;
  const fileAnswers =
    options.answersFile === undefined
      ? {}
      : yield* Effect.tryPromise({
          try: () => readAnswersFile(options.answersFile as string),
          catch: (cause) =>
            new ScratchAppError({
              message: "Could not read scratch answers file.",
              operation: "acquire",
              cause,
              remediation: "Pass a readable JSON object of string answers via --answers <file>.",
            }),
        });
  const answers = { ...fileAnswers, ...(options.answers ?? {}) };
  const acquireBase = {
    source: hasFork
      ? ({ kind: "fork", ...(options.source === undefined ? {} : { path: options.source }) } as const)
      : ({ kind: "recipe", ref: from ?? "" } as const),
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(Object.keys(answers).length === 0 ? {} : { answers }),
    ...(options.yes === undefined ? {} : { yes: options.yes }),
    ...(options.nonInteractive === undefined ? {} : { nonInteractive: options.nonInteractive }),
    ...(options.isolate === undefined ? {} : { isolate: options.isolate }),
    ...(options.mountCwd === undefined ? {} : { mountCwd: options.mountCwd }),
    ...(options.shareGlobalStorage === undefined ? {} : { shareGlobalStorage: options.shareGlobalStorage }),
    ...(options.excludes === undefined ? {} : { excludes: options.excludes }),
    ...(options.keepOnFailure === undefined ? {} : { keepOnFailure: options.keepOnFailure }),
    ...(options.runPostInit === undefined ? {} : { runPostInit: options.runPostInit }),
    ...(options.noLocalOverrides === undefined ? {} : { noLocalOverrides: options.noLocalOverrides }),
    ...(options.noHostnameSuffix === undefined ? {} : { noHostnameSuffix: options.noHostnameSuffix }),
    ...(options.hostnames === undefined ? {} : { hostnames: options.hostnames }),
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
      yield* emitOptionalStdout(`started: ${handle.id} (press Ctrl-C to stop and destroy)\n`);
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

const scratchStatusTone = summaryToneFromTable(SCRATCH_STATUS_TONES, "info");

export const buildScratchListSummary = (result: ReadonlyArray<ScratchSummary>): SummaryDocument => {
  const rows = result.map((entry) => ({
    label: entry.id,
    tone: scratchStatusTone(entry.status),
    value: entry.status,
    fields: [
      { label: "source", value: scratchSourceLabel(entry.source) },
      { label: "mode", value: entry.mode },
      { label: "created", value: entry.created },
    ],
  }));
  return {
    title: "SCRATCH APPS",
    subtitle: `${result.length} ${result.length === 1 ? "app" : "apps"}`,
    tone: result.length === 0 ? "info" : worstSummaryTone(rows.map((row) => row.tone)),
    sections: [
      {
        title: "instances",
        rows,
        ...(result.length === 0 ? { notes: ["No scratch apps found."] } : {}),
      },
    ],
    footer: `${result.length} scratch apps`,
  };
};

export const renderScratchListResult = (
  result: ReadonlyArray<ScratchSummary>,
  _format: ScratchListFormat = "table",
  ctx?: RenderContext,
): string => {
  if (isDecoratedContext(ctx))
    return formatSummary(buildScratchListSummary(result), summaryPaintOptions(ctx));
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
    `candidates: ${report.candidates.length}`,
    ...report.candidates.map((id) => `  ${id}`),
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
      const port = endpoint.protocol === "unix" ? "" : `:${endpoint.port}`;
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

export const renderScratchInfoResult = (
  result: ScratchInfo,
  _format: ScratchListFormat = "table",
): string => {
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
    ...(result.routes === undefined
      ? []
      : result.routes.length === 0
        ? ["routes: (none confirmed by the router)"]
        : ["routes:", ...result.routes.map(({ service, url }) => `  ${service} ${url}`)]),
  ].join("\n");
};

export const scratchStop = (
  id: string,
): Effect.Effect<ScratchHandle, ScratchIdCommandError, ScratchAppService> =>
  Effect.flatMap(validateScratchId(id), (validId) =>
    Effect.flatMap(ScratchAppService, (service) => service.stop(validId)),
  );

export const renderScratchStopResult = (result: ScratchHandle): string =>
  `stopped and destroyed: ${result.id}`;

export const scratchDestroy = (
  id: string,
  options: { readonly keepVolumes?: boolean } = {},
): Effect.Effect<ScratchHandle, ScratchIdCommandError, ScratchAppService> =>
  Effect.flatMap(validateScratchId(id), (validId) =>
    Effect.flatMap(ScratchAppService, (service) => service.destroy(validId, options)),
  );

export const renderScratchDestroyResult = (result: ScratchHandle): string => `destroyed: ${result.id}`;

export type ScratchLogsOptions = Pick<FollowLogsAppOptions, "service" | "tail" | "since" | "source">;
export type ScratchLogsError =
  | ScratchIdCommandError
  | LogsAppError
  | AppResolveError
  | ProviderError
  | NoProviderInstalledError;
type ScratchLogsServices = ScratchAppService | RuntimeProviderRegistry;

/**
 * Resolves applied log evidence exactly, never the acquisition plan cache: the scratch registry
 * handle names the root, and only that root's recorded plan proves what actually runs.
 */
const scratchAppliedPlan = Effect.fnUntraced(function* (id: string) {
  const handle = yield* scratchResolve(id);
  const registry = yield* RuntimeProviderRegistry;
  const discovered = yield* registry.resolveAppliedPlan(
    handle.app.root,
    { kind: "scratch", id: handle.id },
    "exact",
  );
  const plan = discovered === undefined ? undefined : yield* registry.readAppliedPlanStrict(discovered);
  return {
    handle,
    plan:
      plan?.id === handle.id &&
      discovered !== undefined &&
      (plan.identity?.appRoot ?? plan.root) === (discovered.identity?.appRoot ?? discovered.root)
        ? plan
        : undefined,
  };
});

export const scratchLogs = Effect.fn("Scratch.logs")(function* (
  id: string,
  options: ScratchLogsOptions = {},
): Effect.fn.Return<LogsAppResult, ScratchLogsError, ScratchLogsServices> {
  const { handle, plan } = yield* scratchAppliedPlan(id);
  if (plan === undefined) {
    yield* validateSince(options.since);
    return { app: handle.id, lines: [] };
  }
  return yield* logsForPlan(plan, options);
});

export const followScratchLogs = Effect.fn("Scratch.followLogs")(function* (
  id: string,
  options: FollowLogsAppOptions = {},
): Effect.fn.Return<LogsAppResult, ScratchLogsError, ScratchLogsServices> {
  const { handle, plan } = yield* scratchAppliedPlan(id);
  if (plan === undefined) {
    yield* validateSince(options.since);
    return { app: handle.id, lines: [] };
  }
  return yield* followLogsForPlan(plan, options);
});

export const renderScratchLogsResult = renderLogsAppResult;
