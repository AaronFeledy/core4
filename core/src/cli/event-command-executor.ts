import { Cause, Context, Effect, Layer } from "effect";

import { commandFailureCause } from "@lando/sdk/command-result";
import { RENDERER_CAPABILITIES_NONE } from "@lando/sdk/renderer";
import { Renderer } from "@lando/sdk/services";

import { resolveProxyDefaultDomain } from "@lando/engine/config/proxy-default-domain";
import { StreamFrameSink } from "@lando/engine/operations/stream-frame-sink";
import { RuntimeCwd } from "@lando/engine/runtime/cwd";
import { EventCommandExecutor } from "@lando/engine/services/event-command-executor";
import type { EventCommandExecutorInput } from "@lando/engine/services/event-command-executor";
import { withShellRedactionTokens } from "@lando/engine/services/shell-runner";
import { withResolvedCwd } from "@lando/landofile/app-resolution";
import { toolingInputRedactionTokens } from "@lando/landofile/tooling-input-redaction";
import { RedactionService, collectSecretEnvValues } from "@lando/redaction/service";
import * as RendererOutput from "@lando/renderer/output";
import { BuiltInCommandCatalog } from "./built-in-command-catalog-service";
import { type BuiltInCommandEntry, embeddingExemptErrorForCommand } from "./built-in-command-registry";
import { makeNestedCommandInvocation, runCommandLifecycle } from "./command-lifecycle";
import { notImplementedErrorForSpec } from "./deferred-commands";
import { validateEventCommandInput } from "./event-command-input";
import { resolveEventCommandTarget } from "./event-command-target";
import { withRedactedRenderer } from "./redacted-renderer";
import { DEFAULT_RENDERER_MODE, isRendererMode } from "./renderer-selection";
import { ResultTerminal } from "./result-terminal";

const silentRenderer = Renderer.of({
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
});

export const makeEventCommandExecutor = (
  runtimeContext: Context.Context<unknown>,
  fixedEntries: ReadonlyArray<BuiltInCommandEntry> = [],
): Context.Service.Shape<typeof EventCommandExecutor> =>
  EventCommandExecutor.of({
    validate: Effect.fn("EventCommandExecutor.validate")(function* (resolved: EventCommandExecutorInput) {
      const target = yield* resolveEventCommandTarget(
        resolved.command,
        runtimeContext,
        fixedEntries,
        resolved.plan,
      );
      if (target.kind === "built-in" && target.builtIn.status.kind === "deferred") {
        return yield* Effect.fail(notImplementedErrorForSpec(target.builtIn.spec));
      }
      if (target.kind === "built-in" && target.builtIn.status.kind === "embedding-exempt") {
        return yield* Effect.fail(embeddingExemptErrorForCommand(target.builtIn));
      }
      if (target.kind !== "tooling")
        yield* validateEventCommandInput(target.spec, {
          flags: resolved.flags,
          args: resolved.args,
          raw: resolved.argv,
        });
    }),
    run: Effect.fn("EventCommandExecutor.run")(function* (
      this: Context.Service.Shape<typeof EventCommandExecutor>,
      resolved: EventCommandExecutorInput,
    ) {
      return yield* Effect.gen(function* () {
        const target = yield* resolveEventCommandTarget(
          resolved.command,
          runtimeContext,
          fixedEntries,
          resolved.plan,
        );
        if (target.kind === "built-in" && target.builtIn.status.kind === "deferred") {
          return yield* Effect.fail(notImplementedErrorForSpec(target.builtIn.spec));
        }
        if (target.kind === "built-in" && target.builtIn.status.kind === "embedding-exempt") {
          return yield* Effect.fail(embeddingExemptErrorForCommand(target.builtIn));
        }
        const input =
          target.kind === "tooling"
            ? {
                flags: resolved.flags,
                args: resolved.args,
                argv: resolved.argv,
                parsedArgv: [],
                interaction: "non-interactive" as const,
              }
            : yield* validateEventCommandInput(target.spec, {
                flags: resolved.flags,
                args: resolved.args,
                raw: resolved.argv,
              });

        const toolingEnvTokens =
          target.kind === "tooling" && target.toolingTask?.env !== undefined
            ? collectSecretEnvValues(
                Object.fromEntries(
                  Object.entries(target.toolingTask.env).map(([name, value]) => [name, String(value)]),
                ),
              )
            : [];
        const redactionTokens = [
          ...(resolved.redactionTokens ?? []),
          ...toolingEnvTokens,
          ...(target.kind === "tooling"
            ? toolingInputRedactionTokens([target.toolingInput], {
                _tag: "NamedMaps",
                flags: input.flags,
                args: input.args,
                passthroughArgv: input.argv,
              })
            : []),
        ];
        const lifecycleRedaction = yield* RedactionService;
        yield* lifecycleRedaction.registerValues(redactionTokens);
        const inputRedactor = yield* lifecycleRedaction.forProfile("secrets", { sourceEnv: process.env });
        const baseRenderer = yield* Renderer;
        const renderer = resolved.silent === true ? silentRenderer : baseRenderer;

        const operation = target.spec.run(input).pipe(Effect.provideService(RuntimeCwd, resolved.cwd));
        const inCwd = target.spec.namespace === "app" ? withResolvedCwd(resolved.cwd, operation) : operation;
        const streamingMode =
          target.kind !== "built-in"
            ? undefined
            : typeof target.spec.streamingMode === "function"
              ? target.spec.streamingMode(input)
              : target.spec.streamingMode;
        const streamOwner =
          streamingMode === "live"
            ? yield* RendererOutput.makeStreamFrameSink("text").pipe(
                Effect.provideService(Renderer, renderer),
                Effect.provideService(RedactionService, lifecycleRedaction),
              )
            : undefined;
        const streamingCommand =
          streamOwner === undefined
            ? inCwd
            : inCwd.pipe(
                Effect.provideService(StreamFrameSink, streamOwner.sink),
                Effect.scoped,
                Effect.ensuring(streamOwner.finish()),
              );
        const command = withRedactedRenderer(streamingCommand, { redactionTokens }).pipe(
          Effect.provideService(Renderer, renderer),
        );
        const redactedCommand = withShellRedactionTokens(redactionTokens, command);
        const invocation = yield* makeNestedCommandInvocation(target.spec.id, {
          argv: target.kind === "tooling" ? [] : input.argv,
          args: target.kind === "tooling" ? {} : input.args,
          flags: target.kind === "tooling" ? {} : input.flags,
          cwd: resolved.cwd,
        });
        const completion = target.spec.completion;
        const exit = yield* runCommandLifecycle(redactedCommand, {
          invocation,
          ...(completion === undefined ? {} : { completion: (value) => completion(value, input) }),
        }).pipe(Effect.provideService(RedactionService, lifecycleRedaction));
        if (exit._tag === "Success") {
          const completed = exit.value;
          const exitCode = completed.exitCode;
          const value = completed.value;
          if (resolved.silent !== true) {
            const resultTokens = target.spec.redactionTokens?.(value) ?? [];
            const outputRenderer = yield* Renderer;
            if (target.kind === "built-in" && target.spec.render !== undefined) {
              const rendered = target.spec.render(value, input, {
                mode: isRendererMode(outputRenderer.id) ? outputRenderer.id : DEFAULT_RENDERER_MODE,
                format: "text",
                ...(yield* ResultTerminal),
                proxyDefaultDomain: yield* resolveProxyDefaultDomain,
                env: process.env,
              });
              if (rendered !== undefined && rendered.length > 0) {
                yield* withRedactedRenderer(
                  Effect.flatMap(Renderer, (current) => current.output.stdout(`${rendered}\n`)),
                  { redactionTokens: [...redactionTokens, ...resultTokens] },
                );
              }
            } else if (target.kind === "plugin" && target.spec.render !== undefined) {
              yield* withRedactedRenderer(
                target.spec.render({ input, result: value, stdout: "", stderr: "", exitCode }),
                { redactionTokens: [...redactionTokens, ...resultTokens] },
              );
            }
          }
          return {
            exitCode,
            stdout:
              target.kind === "tooling" &&
              typeof value === "object" &&
              value !== null &&
              "stdout" in value &&
              typeof value.stdout === "string"
                ? inputRedactor.redactString(value.stdout)
                : "",
            stderr:
              target.kind === "tooling" &&
              typeof value === "object" &&
              value !== null &&
              "stderr" in value &&
              typeof value.stderr === "string"
                ? inputRedactor.redactString(value.stderr)
                : "",
          };
        }
        if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.interrupt;
        // Nested defects stay typed failures so event-step error mapping still applies.
        return yield* Effect.failCause(commandFailureCause(exit.cause));
      }).pipe(
        Effect.provide(RedactionService.layer),
        Effect.provide(Context.add(runtimeContext, EventCommandExecutor, this)),
      );
    }),
  });

export const layer = Layer.effect(
  EventCommandExecutor,
  Effect.gen(function* () {
    const context = yield* Effect.context<unknown>();
    const catalog = yield* BuiltInCommandCatalog;
    return makeEventCommandExecutor(context, catalog.entries);
  }),
);
