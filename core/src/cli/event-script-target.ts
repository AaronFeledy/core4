import { runBunShellTooling } from "@lando/engine/operations/tooling-bun-script";
import { normalizeBunShellScript } from "@lando/landofile/bun-sh-metadata";
import { readBunShellScript } from "@lando/landofile/bun-sh-script";
import { commandCompletionFromExitCode } from "@lando/sdk/command-result";
import { ToolingCompileError } from "@lando/sdk/errors";
import type { ExecutableCommandSpec } from "@lando/sdk/plugins";
import type { AppPlan } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";

export const resolveEventScriptTarget = Effect.fnUntraced(function* (name: string, plan: AppPlan) {
  const script = yield* readBunShellScript(String(plan.root), `${name.split(":").join("/")}.bun.sh`);
  if (script === undefined) return undefined;
  const metadata = yield* Effect.fromResult(normalizeBunShellScript(script));
  const spec: ExecutableCommandSpec = {
    id: script.id,
    summary: script.summary,
    namespace: "app",
    bootstrap: "tooling",
    resultSchema: Schema.Unknown,
    run: (input) =>
      runBunShellTooling(
        {
          name,
          relativePath: script.relativePath,
          input: { _tag: "NamedMaps", flags: input.flags, args: input.args, passthroughArgv: input.argv },
          expectedInputRevision: metadata.input.revision,
        },
        String(plan.root),
      ).pipe(
        Effect.flatMap((result) =>
          result === undefined
            ? Effect.fail(
                new ToolingCompileError({
                  tool: name,
                  message: `Script-backed tooling command ${name} is no longer available.`,
                  remediation: "Refresh app command metadata and retry.",
                }),
              )
            : Effect.succeed(result),
        ),
      ),
    completion: (result) =>
      commandCompletionFromExitCode(
        Schema.decodeUnknownSync(Schema.Struct({ exitCode: Schema.Number }))(result).exitCode,
      ),
  };
  return { kind: "tooling" as const, spec, toolingName: name, toolingInput: metadata.input };
});
