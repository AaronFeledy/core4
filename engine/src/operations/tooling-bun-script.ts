import { Clock, Effect, Option } from "effect";

import type { ToolingResult } from "@lando/sdk/app";
import { ToolingExecError } from "@lando/sdk/errors";
import type { Environment, ToolingInputRevision, ToolingInvocationInput } from "@lando/sdk/schema";
import { EnvironmentValueResolver, EventService } from "@lando/sdk/services";

import { type DiscoveredBunShellScript, discoverBunShellScripts } from "@lando/landofile/bun-sh-discovery";
import { readBunShellScript } from "@lando/landofile/bun-sh-script";
import { runHostScript } from "../services/host-tooling-engine.ts";
import { commandAliasConflictError, reservedTopLevelAliasOwner } from "./reserved-aliases.ts";
import {
  type PreparedBunShellScript,
  bunShellScriptEnvironment,
  prepareBunShellScript,
  withBunShellScriptInputs,
} from "./tooling-bun-script-input.ts";
import { withToolingOutput } from "./tooling-output.ts";
import { beginLiveToolingTree } from "./tooling-progress.ts";

const HOST_SERVICE = ":host";

export const findBunShellScriptForName = (
  scripts: ReadonlyArray<DiscoveredBunShellScript>,
  name: string,
): DiscoveredBunShellScript | undefined => {
  const target = name.startsWith("app:") ? name : `app:${name}`;
  return scripts.find((script) => script.id === target);
};

interface BunShellScriptOptions {
  readonly expectedInputRevision?: ToolingInputRevision;
  readonly input?: ToolingInvocationInput;
  readonly cwd?: string;
  readonly env?: Environment;
  readonly hostIo?: "stdin" | "terminal";
  readonly signal?: AbortSignal;
}

const executePreparedBunShellScript = Effect.fnUntraced(function* (
  prepared: PreparedBunShellScript,
  appRoot: string,
  options: BunShellScriptOptions,
) {
  const { script } = prepared;
  const cwd = options.cwd ?? appRoot;
  const session = yield* (yield* EnvironmentValueResolver).openSession();
  const resolved = options.env === undefined ? {} : yield* session.resolveEnvironment(options.env);
  const env = bunShellScriptEnvironment(prepared, process.env, resolved);
  const result = yield* runHostScript(script.path, [appRoot], {
    cwd,
    argv: prepared.argv,
    env,
    ...(options.hostIo === undefined ? {} : { hostIo: options.hostIo }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }).pipe(
    Effect.catchTag("ShellExecError", (shellError) =>
      shellError.exitCode !== undefined || options.signal?.aborted === true
        ? Effect.succeed({
            // An interrupted script reports the conventional SIGINT status, like container tooling.
            exitCode: options.signal?.aborted === true ? 130 : (shellError.exitCode ?? 1),
            stdout: shellError.stdout ?? "",
            stderr: shellError.stderr ?? "",
          })
        : Effect.fail(
            new ToolingExecError({
              message: `Script-backed tooling task ${script.id} failed: ${shellError.message}`,
              tool: script.id,
              remediation: `Inspect the tooling task ${script.id} output, fix the script, and rerun the command.`,
              cause: shellError,
            }),
          ),
    ),
  );
  return {
    tool: script.id,
    service: HOST_SERVICE,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  } satisfies ToolingResult;
}, Effect.scoped);

export const runBunShellScript = Effect.fnUntraced(function* (
  script: DiscoveredBunShellScript,
  appRoot: string,
  options: BunShellScriptOptions,
) {
  const prepared = yield* prepareBunShellScript(script, options);
  return yield* withBunShellScriptInputs(prepared, executePreparedBunShellScript(prepared, appRoot, options));
});

export const runBunShellTooling = Effect.fn("AppOperation.bunShellTooling")(function* (
  options: {
    readonly name: string;
    readonly expectedInputRevision?: ToolingInputRevision;
    readonly input?: ToolingInvocationInput;
    readonly cwd?: string;
    readonly env?: Environment;
    readonly hostIo?: "stdin" | "terminal";
    readonly signal?: AbortSignal;
    readonly relativePath?: string;
  },
  appRoot: string,
) {
  const script = yield* options.relativePath === undefined
    ? discoverBunShellScripts({ appRoot }).pipe(
        Effect.map((scripts) => findBunShellScriptForName(scripts, options.name)),
      )
    : readBunShellScript(appRoot, options.relativePath);
  if (script === undefined) return undefined;

  const toolingLookupKey = options.name.startsWith("app:") ? options.name.slice(4) : options.name;
  const reservedOwner = reservedTopLevelAliasOwner(toolingLookupKey);
  if (reservedOwner !== undefined) {
    return yield* Effect.fail(
      commandAliasConflictError(toolingLookupKey, `script-backed tooling task ${script.id}`),
    );
  }

  const prepared = yield* prepareBunShellScript(script, options);
  return yield* withBunShellScriptInputs(
    prepared,
    Effect.gen(function* () {
      const events = yield* Effect.serviceOption(EventService);
      const progressEvents = Option.getOrUndefined(events);
      const liveTree =
        progressEvents === undefined ? undefined : beginLiveToolingTree(progressEvents, script.id);
      if (liveTree !== undefined) yield* liveTree.start;
      const startedAt = yield* Clock.currentTimeMillis;
      const exit = yield* Effect.result(
        withToolingOutput(executePreparedBunShellScript(prepared, appRoot, options)),
      );
      const durationMs = (yield* Clock.currentTimeMillis) - startedAt;
      if (liveTree !== undefined)
        yield* liveTree.finish(exit._tag === "Success" ? exit.success.exitCode : 1, durationMs);
      if (exit._tag === "Failure") return yield* Effect.fail(exit.failure);
      return exit.success satisfies ToolingResult;
    }),
  );
});
