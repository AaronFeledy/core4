import { RedactionService } from "@lando/redaction/service";
import { ProcessRunner } from "@lando/sdk/services";
import { Effect } from "effect";
import { bunSelfRun } from "../../cli/commands/bun-self-runner.ts";
import { recipeAssetDigest } from "../builtin/snapshot-asset.ts";
import type { RecipeInitPipelineRequest } from "../init-pipeline.ts";
import { type PostInitExecutedAction, type PostInitOutcome, runPostInit } from "../post-init/runtime.ts";
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
  const runner = yield* ProcessRunner;
  const context = yield* Effect.context<ProcessRunner>();
  const run = Effect.runPromiseWith(context);
  const executed: PostInitExecutedAction[] = [];
  // One invocation per action limits each raw secret to its one declared consumer.
  for (const entry of plan.actions) {
    const action = entry.value;
    const index = plan.compiled.postInit.indexOf(entry);
    const origin = entry.origin;
    const verifyScript = async (signal: AbortSignal) => {
      if (action.type !== "bun" || action.verb !== "script") return;
      if (origin.kind !== "directory") throw options.postFailure(`postInit[${index}] (script origin)`);
      await run(resolveRecipeDeclarationPath(origin, action.script), { signal });
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
    const redaction = yield* Effect.serviceOption(RedactionService);
    if (redaction._tag === "Some")
      yield* redaction.value.registerValues([...Object.values(env), ...(stdin === undefined ? [] : [stdin])]);
    let pending: Promise<PostInitOutcome> | undefined;
    const outcome = yield* Effect.tryPromise({
      try: (signal) => {
        const execute = async () => {
          await verifyScript(signal);
          const invoke = async (
            cmd: readonly string[],
            cwd: string,
            childEnv: Readonly<Record<string, string>>,
          ) => {
            await verifyScript(signal);
            const [executable, ...args] = cmd;
            if (executable === undefined)
              return Promise.reject(options.postFailure(`postInit[${index}] (${action.type})`));
            return run(
              runner
                .run({
                  cmd: executable,
                  args,
                  cwd,
                  env: childEnv,
                  capture: true,
                  ...(stdin === undefined ? {} : { stdin }),
                })
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
            runBun: async ({ argv, cwd, execPath }) => {
              await verifyScript(signal);
              return run(
                bunSelfRun({
                  argv,
                  cwd,
                  env,
                  signal,
                  ...(execPath === undefined ? {} : { execPath }),
                  callerSubsystem: "recipe-post-init",
                  ...(stdin === undefined ? {} : { stdin }),
                }),
                { signal },
              );
            },
            commandRunner: ({ command, args }) =>
              invoke(
                [...landoInvocationPrefix(process.execPath, process.argv), command, ...args],
                plan.appRoot,
                env,
              ),
          });
        };
        pending = execute();
        return pending;
      },
      catch: (cause) =>
        cause instanceof RecipeInitPostInitError
          ? cause
          : options.postFailure(`postInit[${index}] (${action.type})`),
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.promise(async () => {
          if (pending !== undefined) await Promise.allSettled([pending]);
        }),
      ),
    );
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
