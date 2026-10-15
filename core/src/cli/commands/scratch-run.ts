import { Effect, Option, Schema } from "effect";

import {
  type ConfigError,
  type LandofileVersionConstraintError,
  ScratchAppError,
  type ScratchAppNotFoundError,
  type ScratchIsolationConflictError,
  ScratchRunTargetError,
  type ScratchSourceUnresolvedError,
} from "@lando/sdk/errors";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import {
  type ConfigService,
  type FileSystem,
  RuntimeProviderRegistry,
  type ScratchAppService,
} from "@lando/sdk/services";

import { withAgentContextEnv } from "@lando/engine/config/agent-env";
import { resolveAgentEnvForwardAllowlist } from "@lando/engine/config/agent-env-policy";
import { execServiceCommand } from "@lando/engine/operations/exec";
import { StreamFrameSink } from "@lando/engine/operations/stream-frame-sink";
import {
  acquireScratchAppWithPlan,
  detachScratchApp,
  findPrimaryServiceName,
  readScratchLandofile,
} from "@lando/engine/scratch-app/service";
import { RedactionService } from "@lando/redaction/service";
import { writeDiagnosticLine } from "@lando/renderer/output";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { finishCommandProgress } from "../command-progress";
import { withInheritedStdinRawMode } from "../exec-host-io";
import type { ScratchRunOptions } from "./scratch-run-input";

export {
  type ScratchRunOptions,
  normalizeScratchRunArgvForParsing,
  parseScratchRunArgv,
  scratchRunHasCommandTail,
  scratchRunOptionsFromInput,
} from "./scratch-run-input";

export const DEFAULT_SCRATCH_RUN_RECIPE = "toolbox";

export interface ScratchRunResult {
  readonly scratchId: string;
  readonly service: string;
  readonly command: ReadonlyArray<string>;
  readonly exitCode: number;
  readonly kept: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly redactionTokens?: ReadonlyArray<string>;
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
  | ScratchRunTargetError
  | ConfigError
  | LandofileVersionConstraintError;

export type ScratchRunServices =
  | ScratchAppService
  | ConfigService
  | FileSystem
  | PrivateFileAccessService
  | RuntimeProviderRegistry;

export interface ScratchRunDeps {
  readonly acquireWithPlan: typeof acquireScratchAppWithPlan;
  readonly detach: (
    id: string,
  ) => Effect.Effect<void, ScratchAppError | ScratchAppNotFoundError, PrivateFileAccessService>;
  readonly readLandofile: typeof readScratchLandofile;
}

export const defaultScratchRunDeps: ScratchRunDeps = {
  acquireWithPlan: acquireScratchAppWithPlan,
  detach: (id) =>
    PrivateFileAccessService.pipe(
      Effect.flatMap((privateFileAccess) => detachScratchApp(id, privateFileAccess)),
    ),
  readLandofile: readScratchLandofile,
};

const MIN_REDACTION_TOKEN_LENGTH = 8;

const redactionTokensFromEnv = (env: Readonly<Record<string, string>> | undefined): ReadonlyArray<string> => {
  if (env === undefined) return [];
  return Object.values(env).filter((value) => value.trim().length >= MIN_REDACTION_TOKEN_LENGTH);
};

export const scratchRunRedactionTokens = (result: ScratchRunResult): ReadonlyArray<string> =>
  result.redactionTokens ?? [];

const usageError = (message: string): ScratchAppError =>
  new ScratchAppError({
    message,
    operation: "run",
    remediation: "Pass the tool command after `--`, e.g. `lando run -- composer install`.",
  });

const resolveRunService = (
  requested: string | undefined,
  plan: AppPlan,
): Effect.Effect<ServicePlan, ScratchRunTargetError> => {
  const available = Object.keys(plan.services).sort();
  if (requested !== undefined && requested.length > 0) {
    const match = Object.values(plan.services).find((service) => String(service.name) === requested);
    if (match !== undefined) return Effect.succeed(match);
    return Effect.fail(
      new ScratchRunTargetError({
        message: `Service ${requested} is not defined by this recipe (available: ${available.join(", ")}).`,
        service: requested,
        available,
        remediation: `Pass --service with one of: ${available.join(", ")}.`,
      }),
    );
  }
  const primaryName = findPrimaryServiceName(plan);
  const primary =
    primaryName === undefined
      ? undefined
      : Object.values(plan.services).find((service) => service.name === primaryName);
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

export const scratchRun = Effect.fn("ScratchRun.run")(function* (
  options: ScratchRunOptions,
  deps: ScratchRunDeps = defaultScratchRunDeps,
): Effect.fn.Return<ScratchRunResult, ScratchRunError, ScratchRunServices> {
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
      const service = yield* resolveRunService(options.service, plan);
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
      const landofile = yield* deps.readLandofile(handle.id);
      const allowlist = yield* resolveAgentEnvForwardAllowlist(landofile.agentEnv, process.env);
      const env = withAgentContextEnv(undefined, process.env, {
        allowlist,
        lowerThanEnv: service.environment,
      });
      // Chunks stream before the result exists, so forwarded values must reach sinks already built.
      const redaction = yield* Effect.serviceOption(RedactionService);
      if (Option.isSome(redaction)) yield* redaction.value.registerValues(redactionTokensFromEnv(env));
      const cliTextOutput = options.hostIo === "cli" && options.envelopeFormat !== true;
      if (cliTextOutput) yield* finishCommandProgress();
      const sink = yield* Effect.serviceOption(StreamFrameSink);
      const execute = execServiceCommand(
        {
          provider,
          target: { app: plan.id, service: service.name, plan },
          service,
          options: { ...options, ...(env === undefined ? {} : { env }) },
        },
        sink,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ScratchAppError({
              message: `Unable to run ${options.command.join(" ")} in scratch app ${handle.id}.`,
              operation: "run",
              cause,
            }),
        ),
      );
      const result = yield* options.hostIo === "cli" && options.tty === true
        ? withInheritedStdinRawMode(true, execute)
        : execute;
      if (options.keep) {
        yield* deps.detach(handle.id);
        if (cliTextOutput) yield* writeDiagnosticLine(`kept: ${handle.id}`);
      }
      return {
        scratchId: handle.id,
        service: String(service.name),
        command: options.command,
        exitCode: result.exitCode,
        kept: options.keep,
        stdout: result.stdout,
        stderr: result.stderr,
        redactionTokens: redactionTokensFromEnv(env),
      } satisfies ScratchRunResult;
    }),
  );
});

export const scratchRunSuccessExitCode = (result: ScratchRunResult): number | undefined =>
  result.exitCode === 0 ? undefined : result.exitCode;
