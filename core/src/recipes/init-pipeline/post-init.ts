import { ProcessRunnerLive } from "@lando/engine/services/process-runner";
import { ProcessRunner } from "@lando/sdk/services";
import { Effect, Option } from "effect";
import type { RecipeInitPipelineRequest, RecipeInitPostInitError } from "../init-pipeline.ts";
import { type PostInitExecutedAction, runPostInit } from "../post-init/runtime.ts";
import { landoInvocationPrefix } from "../prompts/choices-command.ts";

export const runBoundPostInit = (options: {
  readonly request: RecipeInitPipelineRequest;
  readonly redact: (text: string) => string;
  readonly postFailure: (action: string) => RecipeInitPostInitError;
}) =>
  Effect.gen(function* () {
    const { request, redact } = options;
    const provided = yield* Effect.serviceOption(ProcessRunner);
    const runner = Option.isSome(provided)
      ? provided.value
      : yield* ProcessRunner.pipe(Effect.provide(ProcessRunnerLive));
    const executed: PostInitExecutedAction[] = [];
    // One invocation per action limits each raw secret to its one declared consumer.
    for (const [index, action] of (request.manifest.postInit ?? []).entries()) {
      const env: Record<string, string> = {};
      let stdin: string | undefined;
      switch (action.type) {
        case "command":
        case "bun":
          for (const prompt of request.manifest.prompts ?? []) {
            const disposition = prompt.disposition;
            if (prompt.type !== "secret" || disposition?.kind !== "init-only") continue;
            const value = request.secretAnswers?.[prompt.name];
            if (value === undefined) continue;
            switch (disposition.sink.kind) {
              case "stdin":
                if (action.stdin?.prompt === prompt.name) stdin = value;
                break;
              case "secretEnv":
                if (action.secretEnv?.[disposition.sink.name] === prompt.name)
                  env[disposition.sink.name] = value;
                break;
              default:
                disposition.sink satisfies never;
            }
          }
          break;
        case "gitInit":
        case "message":
          break;
        default:
          action satisfies never;
      }
      const invoke = (cmd: readonly string[], cwd: string, childEnv: Readonly<Record<string, string>>) => {
        const [executable, ...args] = cmd;
        if (executable === undefined)
          return Promise.reject(options.postFailure(`postInit[${index}] (${action.type})`));
        return Effect.runPromise(
          runner
            .run({ cmd: executable, args, cwd, env: childEnv, ...(stdin === undefined ? {} : { stdin }) })
            .pipe(
              Effect.map((result) => ({
                ...result,
                stdout: redact(result.stdout),
                stderr: redact(result.stderr),
              })),
            ),
        );
      };
      const outcome = yield* Effect.tryPromise({
        try: () =>
          (request.runPostInit ?? runPostInit)({
            actions: [action],
            destination: request.appRoot,
            recipeId: request.manifest.id,
            appName: request.appName,
            answers: request.answers,
            env,
            ...(request.manifest.runs === undefined ? {} : { runs: request.manifest.runs }),
            spawner: { spawn: ({ cmd, cwd, env }) => invoke(cmd, cwd, env) },
            commandRunner: ({ command, args }) =>
              invoke(
                [...landoInvocationPrefix(process.execPath, process.argv), command, ...args],
                request.appRoot,
                env,
              ),
          }),
        catch: () => options.postFailure(`postInit[${index}] (${action.type})`),
      });
      for (const item of outcome.executed)
        executed.push({
          index,
          type: redact(item.type),
          ...(item.verb === undefined ? {} : { verb: redact(item.verb) }),
          ...(item.skipped === undefined ? {} : { skipped: item.skipped }),
        });
    }
    return { executed };
  });
