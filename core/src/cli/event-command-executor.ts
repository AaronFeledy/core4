import { Cause, Context, Effect, Layer } from "effect";

import { RENDERER_CAPABILITIES_NONE } from "@lando/sdk/renderer";
import { Renderer } from "@lando/sdk/services";

import { RuntimeCwd } from "@lando/engine/runtime/cwd";
import { EventCommandExecutor } from "@lando/engine/services/event-command-executor";
import type { EventCommandExecutorInput } from "@lando/engine/services/event-command-executor";
import { withShellRedactionTokens } from "@lando/engine/services/shell-runner";
import { withResolvedCwd } from "@lando/landofile/app-resolution";
import type { BuiltInCommandEntry } from "./built-in-command-registry";
import { makeNestedCommandInvocation, runCommandLifecycle } from "./command-lifecycle";
import { notImplementedErrorForSpec } from "./deferred-commands";
import { validateEventCommandInput } from "./event-command-input";
import { resolveEventCommandTarget } from "./event-command-target";
import { DEFAULT_RENDERER_MODE, isRendererMode } from "./renderer-selection";

let eventCommandEntries: ReadonlyArray<BuiltInCommandEntry> = [];

export const injectEventCommandRegistry = (entries: ReadonlyArray<BuiltInCommandEntry>): void => {
  eventCommandEntries = entries;
};

const silentRenderer = {
  id: "silent",
  capabilities: RENDERER_CAPABILITIES_NONE,
  message: {
    info: () => Effect.void,
    warn: () => Effect.void,
    error: () => Effect.void,
  },
  output: {
    stdout: () => Effect.void,
    stderr: () => Effect.void,
  },
} satisfies Context.Tag.Service<typeof Renderer>;

export const makeEventCommandExecutor = (
  runtimeContext: Context.Context<unknown>,
  fixedEntries?: ReadonlyArray<BuiltInCommandEntry>,
): Context.Tag.Service<typeof EventCommandExecutor> => ({
  validate(resolved) {
    return Effect.gen(function* () {
      const target = yield* resolveEventCommandTarget(
        resolved.command,
        runtimeContext,
        fixedEntries ?? eventCommandEntries,
        resolved.plan,
      );
      yield* validateEventCommandInput(target.spec, {
        flags: resolved.flags,
        args: resolved.args,
        raw: resolved.argv,
      });
    });
  },
  run(resolved: EventCommandExecutorInput) {
    return Effect.gen(function* () {
      const entries = fixedEntries ?? eventCommandEntries;
      const target = yield* resolveEventCommandTarget(
        resolved.command,
        runtimeContext,
        entries,
        resolved.plan,
      );
      if (target.kind === "built-in" && target.builtIn.status.kind === "deferred") {
        return yield* Effect.fail(notImplementedErrorForSpec(target.builtIn.spec));
      }
      const input = yield* validateEventCommandInput(target.spec, {
        flags: resolved.flags,
        args: resolved.args,
        raw: resolved.argv,
      });

      const operation = target.spec.run(input).pipe(Effect.provideService(RuntimeCwd, resolved.cwd));
      const inCwd = target.spec.namespace === "app" ? withResolvedCwd(resolved.cwd, operation) : operation;
      const command =
        resolved.silent === true ? inCwd.pipe(Effect.provideService(Renderer, silentRenderer)) : inCwd;
      const redactedCommand = withShellRedactionTokens(resolved.redactionTokens ?? [], command);
      const invocation = yield* makeNestedCommandInvocation(target.spec.id, {
        argv: input.argv,
        args: input.args,
        flags: input.flags,
        cwd: resolved.cwd,
      });
      const exit = yield* runCommandLifecycle(redactedCommand, {
        invocation,
        ...(target.spec.successExitCode === undefined
          ? {}
          : { successExitCode: (value) => target.spec.successExitCode?.(value, input) }),
      });
      if (exit._tag === "Success") {
        const render = target.kind === "built-in" ? target.spec.render : undefined;
        if (resolved.silent !== true && render !== undefined) {
          const renderer = yield* Renderer;
          const rendered = render(exit.value, input, {
            mode: isRendererMode(renderer.id) ? renderer.id : DEFAULT_RENDERER_MODE,
            format: "text",
            columns: undefined,
            isTTY: renderer.capabilities.interactive,
          });
          if (rendered !== undefined && rendered.length > 0) {
            yield* renderer.output.stdout(`${rendered}\n`);
          }
        }
        return {
          exitCode: target.spec.successExitCode?.(exit.value, input) ?? 0,
          stdout: "",
          stderr: "",
        };
      }
      if (Cause.isInterruptedOnly(exit.cause)) return yield* Effect.interrupt;
      return yield* Effect.fail(Cause.squash(exit.cause));
    }).pipe(Effect.provide(Context.add(runtimeContext, EventCommandExecutor, this)));
  },
});

export const EventCommandExecutorLive = Layer.effect(
  EventCommandExecutor,
  Effect.map(Effect.context<unknown>(), makeEventCommandExecutor),
);
