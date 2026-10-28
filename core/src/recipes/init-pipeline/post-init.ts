import * as BunProcessRunner from "@lando/engine/services/process-runner";
import { ProcessRunner } from "@lando/sdk/services";
import { Effect, Option } from "effect";
import { recipeAssetDigest } from "../builtin/snapshot-asset.ts";
import type { RecipeInitPipelineRequest } from "../init-pipeline.ts";
import { type PostInitExecutedAction, runPostInit } from "../post-init/runtime.ts";
import { landoInvocationPrefix } from "../prompts/choices-command.ts";
import { resolveRecipeDeclarationPath } from "../source-declaration-path.ts";
import { RecipeInitPostInitError } from "./errors.ts";
import { readAuxiliaryScaffoldContent } from "./files.ts";

export const runBoundPostInit = Effect.fn("RecipeInitPipeline.postInit")(function* (options: {
  readonly request: RecipeInitPipelineRequest;
  readonly redact: (text: string) => string;
  readonly postFailure: (action: string) => RecipeInitPostInitError;
}) {
  const { request, redact } = options;
  const plan = request.prepared;
  const provided = yield* Effect.serviceOption(ProcessRunner);
  const runner = Option.isSome(provided)
    ? provided.value
    : yield* ProcessRunner.pipe(Effect.provide(BunProcessRunner.layer));
  const executed: PostInitExecutedAction[] = [];
  // One invocation per action limits each raw secret to its one declared consumer.
  for (const entry of plan.actions) {
    const action = entry.value;
    const index = plan.compiled.postInit.indexOf(entry);
    const origin = entry.origin;
    const verifyScript = async () => {
      if (action.type !== "bun" || action.verb !== "script") return;
      if (origin.kind !== "directory") throw options.postFailure(`postInit[${index}] (script origin)`);
      await Effect.runPromise(resolveRecipeDeclarationPath(origin, action.script));
      const content = await readAuxiliaryScaffoldContent({
        file: { src: action.script, dest: action.script },
        appName: plan.appName,
        sourceRoot: origin.root,
      });
      if (entry.digest === undefined || recipeAssetDigest(content) !== entry.digest)
        throw options.postFailure(`postInit[${index}] (script changed)`);
    };
    const env: Record<string, string> = {};
    let stdin: string | undefined;
    switch (action.type) {
      case "command":
      case "bun":
        for (const prompt of plan.compiled.manifest.prompts ?? []) {
          const disposition = prompt.disposition;
          if (prompt.type !== "secret" || disposition?.kind !== "init-only") continue;
          const value = plan.secretAnswers?.[prompt.name];
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
    const outcome = yield* Effect.tryPromise({
      try: async (signal) => {
        await verifyScript();
        const invoke = async (
          cmd: readonly string[],
          cwd: string,
          childEnv: Readonly<Record<string, string>>,
        ) => {
          await verifyScript();
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
            { signal },
          );
        };
        return (request.runPostInit ?? runPostInit)({
          redact,
          actions: [action],
          destination: plan.appRoot,
          recipeId: plan.compiled.manifest.id,
          appName: plan.appName,
          answers: plan.answers,
          ...(origin.kind === "directory" ? { recipeRoot: origin.root } : {}),
          env,
          ...(plan.compiled.manifest.runs === undefined ? {} : { runs: plan.compiled.manifest.runs }),
          spawner: { spawn: ({ cmd, cwd, env }) => invoke(cmd, cwd, env) },
          commandRunner: ({ command, args }) =>
            invoke(
              [...landoInvocationPrefix(process.execPath, process.argv), command, ...args],
              plan.appRoot,
              env,
            ),
        });
      },
      catch: (cause) =>
        cause instanceof RecipeInitPostInitError
          ? cause
          : options.postFailure(`postInit[${index}] (${action.type})`),
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
