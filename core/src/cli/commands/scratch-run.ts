import { Effect, Schema } from "effect";

import {
  ScratchAppError,
  type ScratchAppNotFoundError,
  type ScratchIsolationConflictError,
  ScratchRunTargetError,
  type ScratchSourceUnresolvedError,
} from "@lando/sdk/errors";
import type { AppPlan, ServiceName } from "@lando/sdk/schema";
import { type FileSystem, RuntimeProviderRegistry, type ScratchAppService } from "@lando/sdk/services";

import {
  acquireScratchAppWithPlan,
  detachScratchApp,
  findPrimaryServiceName,
} from "../../scratch-app/service.ts";
import { parseAnswerFlags } from "../prompts/answer-flags.ts";
import { emitOptionalStderr } from "../renderer-boundary.ts";

export const DEFAULT_SCRATCH_RUN_RECIPE = "toolbox";

export interface ScratchRunOptions {
  readonly command: ReadonlyArray<string>;
  readonly from?: string;
  readonly service?: string;
  readonly mount: boolean;
  readonly answers: Record<string, string>;
  readonly keep: boolean;
  readonly issues: ReadonlyArray<string>;
  readonly signal?: AbortSignal;
}

export interface ScratchRunResult {
  readonly scratchId: string;
  readonly service: string;
  readonly command: ReadonlyArray<string>;
  readonly exitCode: number;
  readonly kept: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export const ScratchRunResultSchema = Schema.Struct({
  scratchId: Schema.String,
  service: Schema.String,
  command: Schema.Array(Schema.String),
  exitCode: Schema.Number,
  kept: Schema.Boolean,
  stdout: Schema.String,
  stderr: Schema.String,
});

export type ScratchRunError =
  | ScratchSourceUnresolvedError
  | ScratchIsolationConflictError
  | ScratchAppError
  | ScratchAppNotFoundError
  | ScratchRunTargetError;

export type ScratchRunServices = ScratchAppService | FileSystem | RuntimeProviderRegistry;

const VALUE_FLAGS = new Map<string, "from" | "service" | "answer">([
  ["--from", "from"],
  ["--service", "service"],
  ["--answer", "answer"],
]);

interface MutableParse {
  command: string[];
  from?: string;
  service?: string;
  mount: boolean;
  answerFlags: string[];
  keep: boolean;
  issues: string[];
}

const consumeValueFlag = (
  parse: MutableParse,
  argv: ReadonlyArray<string>,
  index: number,
): number | undefined => {
  const arg = argv[index];
  if (arg === undefined) return undefined;
  const equals = arg.indexOf("=");
  const name = equals === -1 ? arg : arg.slice(0, equals);
  const kind = VALUE_FLAGS.get(name);
  if (kind === undefined) return undefined;
  let value: string | undefined;
  let consumed = 1;
  if (equals !== -1) {
    value = arg.slice(equals + 1);
  } else {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("-")) {
      parse.issues.push(`Flag ${name} expects a value.`);
      return 1;
    }
    value = next;
    consumed = 2;
  }
  if (kind === "answer") parse.answerFlags.push(value);
  else parse[kind] = value;
  return consumed;
};

export const parseScratchRunArgv = (argv: ReadonlyArray<string>): ScratchRunOptions => {
  const parse: MutableParse = { command: [], mount: true, answerFlags: [], keep: false, issues: [] };
  let index = 0;
  let commandStarted = false;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === undefined) {
      index += 1;
      continue;
    }
    if (commandStarted) {
      parse.command.push(arg);
      index += 1;
      continue;
    }
    if (arg === "--") {
      commandStarted = true;
      index += 1;
      continue;
    }
    if (arg === "--no-mount") {
      parse.mount = false;
      index += 1;
      continue;
    }
    if (arg === "--keep") {
      parse.keep = true;
      index += 1;
      continue;
    }
    const consumed = consumeValueFlag(parse, argv, index);
    if (consumed !== undefined) {
      index += consumed;
      continue;
    }
    commandStarted = true;
    parse.command.push(arg);
    index += 1;
  }
  return {
    command: parse.command,
    ...(parse.from === undefined ? {} : { from: parse.from }),
    ...(parse.service === undefined ? {} : { service: parse.service }),
    mount: parse.mount,
    answers: parseAnswerFlags(parse.answerFlags),
    keep: parse.keep,
    issues: parse.issues,
  };
};

export const scratchRunOptionsFromInput = (input: unknown): ScratchRunOptions => {
  const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const argv = Array.isArray(record.argv)
    ? record.argv.filter((entry): entry is string => typeof entry === "string")
    : [];
  const signal = record.signal instanceof AbortSignal ? record.signal : undefined;
  return { ...parseScratchRunArgv(argv), ...(signal === undefined ? {} : { signal }) };
};

export interface ScratchRunDeps {
  readonly acquireWithPlan: typeof acquireScratchAppWithPlan;
  readonly detach: typeof detachScratchApp;
  readonly stdinIsTty: () => boolean;
}

export const defaultScratchRunDeps: ScratchRunDeps = {
  acquireWithPlan: acquireScratchAppWithPlan,
  detach: detachScratchApp,
  stdinIsTty: () => process.stdin.isTTY === true,
};

const usageError = (message: string): ScratchAppError =>
  new ScratchAppError({
    message,
    operation: "run",
    remediation: "Pass the tool command after `--`, e.g. `lando run -- composer install`.",
  });

const resolveRunService = (
  requested: string | undefined,
  plan: AppPlan,
): Effect.Effect<ServiceName, ScratchRunTargetError> => {
  const available = Object.keys(plan.services).sort();
  if (requested !== undefined && requested.length > 0) {
    const match = Object.values(plan.services).find((service) => String(service.name) === requested);
    if (match !== undefined) return Effect.succeed(match.name);
    return Effect.fail(
      new ScratchRunTargetError({
        message: `Service ${requested} is not defined by this recipe (available: ${available.join(", ")}).`,
        service: requested,
        available,
        remediation: `Pass --service with one of: ${available.join(", ")}.`,
      }),
    );
  }
  const primary = findPrimaryServiceName(plan);
  if (primary !== undefined) return Effect.succeed(primary);
  return Effect.fail(
    new ScratchRunTargetError({
      message: "The resolved recipe defines no services to run the command in.",
      service: "",
      available,
      remediation: "Use --from with a recipe that defines at least one service.",
    }),
  );
};

export const scratchRun = (
  options: ScratchRunOptions,
  deps: ScratchRunDeps = defaultScratchRunDeps,
): Effect.Effect<ScratchRunResult, ScratchRunError, ScratchRunServices> =>
  Effect.gen(function* () {
    const issue = options.issues[0];
    if (issue !== undefined) return yield* Effect.fail(usageError(issue));
    if (options.command.length === 0) {
      return yield* Effect.fail(usageError("apps:scratch:run requires a command to run."));
    }
    const registry = yield* RuntimeProviderRegistry;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const { handle, plan } = yield* deps.acquireWithPlan({
          source: { kind: "recipe", ref: options.from ?? DEFAULT_SCRATCH_RUN_RECIPE },
          isolate: options.mount ? "cwd" : "baked",
          detached: false,
          ...(Object.keys(options.answers).length === 0 ? {} : { answers: options.answers }),
          ...(options.mount ? { mountCwd: {} } : {}),
        });
        const serviceName = yield* resolveRunService(options.service, plan);
        const provider = yield* registry.select(plan).pipe(
          Effect.mapError(
            (cause) =>
              new ScratchAppError({
                message: `Unable to select a provider for scratch app ${handle.id}.`,
                operation: "run",
                cause,
              }),
          ),
        );
        const tty = deps.stdinIsTty();
        const result = yield* provider
          .exec(
            { app: plan.id, service: serviceName, plan },
            {
              command: options.command,
              ...(tty ? { tty: true, stdin: "inherit" as const } : {}),
              ...(options.signal === undefined ? {} : { signal: options.signal }),
            },
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new ScratchAppError({
                  message: `Unable to run ${options.command.join(" ")} in scratch app ${handle.id}.`,
                  operation: "run",
                  cause,
                }),
            ),
          );
        if (result.stderr.length > 0) yield* emitOptionalStderr(result.stderr);
        if (options.keep) yield* deps.detach(handle.id);
        return {
          scratchId: handle.id,
          service: String(serviceName),
          command: options.command,
          exitCode: result.exitCode,
          kept: options.keep,
          stdout: result.stdout,
          stderr: result.stderr,
        } satisfies ScratchRunResult;
      }),
    );
  });

export const renderScratchRunResult = (result: ScratchRunResult): string | undefined => {
  const lines: string[] = [];
  if (result.stdout.length > 0) {
    lines.push(result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout);
  }
  if (result.kept) lines.push(`kept: ${result.scratchId}`);
  return lines.length === 0 ? undefined : lines.join("\n");
};

export const scratchRunSuccessExitCode = (result: ScratchRunResult): number | undefined =>
  result.exitCode === 0 ? undefined : result.exitCode;
