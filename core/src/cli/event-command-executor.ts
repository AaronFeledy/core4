import { Cause, Context, Effect, Layer } from "effect";

import { RENDERER_CAPABILITIES_NONE } from "@lando/sdk/renderer";
import { Renderer } from "@lando/sdk/services";

import { RuntimeCwd } from "@lando/engine/runtime/cwd";
import { EventCommandExecutor } from "@lando/engine/services/event-command-executor";
import type { EventCommandExecutorInput } from "@lando/engine/services/event-command-executor";
import { withShellRedactionTokens } from "@lando/engine/services/shell-runner";
import { withResolvedCwd } from "@lando/landofile/app-resolution";
import { RedactionService, collectSecretEnvValues, createStandaloneRedactor } from "@lando/redaction/service";
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

const redactorFor = (tokens: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const service = yield* Effect.serviceOption(RedactionService);
    return service._tag === "Some"
      ? yield* service.value.forProfile("secrets", { sourceEnv: process.env, redactionTokens: tokens })
      : createStandaloneRedactor("secrets", { sourceEnv: process.env, redactionTokens: tokens });
  });

const redactionServiceFor = (tokens: ReadonlyArray<string>) =>
  Effect.serviceOption(RedactionService).pipe(
    Effect.map(
      (service): Context.Tag.Service<typeof RedactionService> => ({
        forProfile: (profile, options) => {
          const scoped = {
            ...options,
            redactionTokens: [...(options?.redactionTokens ?? []), ...tokens],
          };
          return service._tag === "Some"
            ? service.value.forProfile(profile, scoped)
            : Effect.succeed(createStandaloneRedactor(profile, scoped));
        },
      }),
    ),
  );

const withRedaction = (
  renderer: Context.Tag.Service<typeof Renderer>,
  redact: (value: string) => string,
): Context.Tag.Service<typeof Renderer> => ({
  id: renderer.id,
  capabilities: renderer.capabilities,
  message: {
    info: (body) => renderer.message.info(redact(body)),
    warn: (body) => renderer.message.warn(redact(body)),
    error: (body, remediation) =>
      renderer.message.error(redact(body), remediation === undefined ? undefined : redact(remediation)),
  },
  output: {
    stdout: (chunk) => renderer.output.stdout(redact(chunk)),
    stderr: (chunk) => renderer.output.stderr(redact(chunk)),
  },
});

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

      const toolingEnvTokens =
        target.kind === "tooling" && target.toolingTask.env !== undefined
          ? collectSecretEnvValues(
              Object.fromEntries(
                Object.entries(target.toolingTask.env).map(([name, value]) => [name, String(value)]),
              ),
            )
          : [];
      const redactionTokens = [...(resolved.redactionTokens ?? []), ...toolingEnvTokens];
      const inputRedactor = yield* redactorFor(redactionTokens);
      const lifecycleRedaction = yield* redactionServiceFor(redactionTokens);
      const renderer =
        resolved.silent === true
          ? silentRenderer
          : withRedaction(yield* Renderer, inputRedactor.redactString);

      const operation = target.spec.run(input).pipe(Effect.provideService(RuntimeCwd, resolved.cwd));
      const inCwd = target.spec.namespace === "app" ? withResolvedCwd(resolved.cwd, operation) : operation;
      const command = inCwd.pipe(Effect.provideService(Renderer, renderer));
      const redactedCommand = withShellRedactionTokens(redactionTokens, command);
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
      }).pipe(Effect.provideService(RedactionService, lifecycleRedaction));
      if (exit._tag === "Success") {
        const exitCode = target.spec.successExitCode?.(exit.value, input) ?? 0;
        if (resolved.silent !== true) {
          const resultTokens =
            target.kind === "built-in" ? (target.spec.redactionTokens?.(exit.value) ?? []) : [];
          const outputRedactor = yield* redactorFor([...redactionTokens, ...resultTokens]);
          const outputRenderer = withRedaction(yield* Renderer, outputRedactor.redactString);
          if (target.kind === "built-in" && target.spec.render !== undefined) {
            const rendered = target.spec.render(exit.value, input, {
              mode: isRendererMode(outputRenderer.id) ? outputRenderer.id : DEFAULT_RENDERER_MODE,
              format: "text",
              columns: undefined,
              isTTY: outputRenderer.capabilities.interactive,
            });
            if (rendered !== undefined && rendered.length > 0) {
              yield* outputRenderer.output.stdout(`${rendered}\n`);
            }
          } else if (target.kind === "plugin" && target.spec.render !== undefined) {
            yield* target.spec
              .render({ input, result: exit.value, stdout: "", stderr: "", exitCode })
              .pipe(Effect.provideService(Renderer, outputRenderer));
          }
        }
        return {
          exitCode,
          stdout:
            target.kind === "tooling" &&
            typeof exit.value === "object" &&
            exit.value !== null &&
            "stdout" in exit.value &&
            typeof exit.value.stdout === "string"
              ? inputRedactor.redactString(exit.value.stdout)
              : "",
          stderr:
            target.kind === "tooling" &&
            typeof exit.value === "object" &&
            exit.value !== null &&
            "stderr" in exit.value &&
            typeof exit.value.stderr === "string"
              ? inputRedactor.redactString(exit.value.stderr)
              : "",
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
