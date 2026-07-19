/**
 * `McpService` — the in-process MCP dispatch core.
 *
 * `McpService` is core-owned and not plugin-replaceable in v4.0. It is a
 * projection over the canonical command registry: `catalog` lists the effective
 * tool set and `serve` runs a retained-runtime dispatch loop over an
 * `McpTransport`. The concrete registry, retained-runtime layer, and stdio
 * transport are supplied by the `meta:mcp` command; this service owns catalog
 * generation, dispatch, non-interactive execution, bounded concurrency,
 * cancellation, redaction, and `pre-mcp-call` / `post-mcp-call` events.
 *
 * The Live layer is registered lazily (`Layer.suspend`, level `plugins`):
 * nothing constructs it unless `meta:mcp` or a library host requests it.
 */
import { Cause, Context, Deferred, Effect, type Exit, Fiber, Layer, Option, Ref } from "effect";

import { McpTransportError } from "@lando/sdk/errors";
import type { LandoEvent } from "@lando/sdk/events";
import type { McpCatalog, McpCatalogOptions, McpServeOptions } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import { EventService } from "@lando/sdk/services";

import { makeNestedCommandInvocation, runCommandLifecycle } from "../cli/command-lifecycle.ts";
import type { CommandResultOutcome } from "../cli/result-encode.ts";
import { StreamFrameSink, type StreamFrameSinkFrame } from "../cli/stream-frame-sink.ts";
import { RedactionService } from "../redaction/service.ts";
import { RuntimeCwd } from "../runtime/cwd.ts";
import { redactBoundedJsonValue } from "./bounded-json.ts";
import {
  emptyCompletedRequestIds,
  forgetCompletedRequestId,
  rememberCompletedRequestId,
  replyMcpCanceled,
} from "./cancellation.ts";
import { buildCatalog, computeEffectiveAllowlist } from "./catalog.ts";
import { type McpDispatchDeps, type McpNotify, dispatchTool } from "./dispatch.ts";
import type { McpCommandEntry } from "./registry.ts";
import { projectMcpProgressFrame } from "./result-inspector.ts";
import { McpTransport, type McpTransportRequest } from "./transport.ts";

/** Default in-flight tool-call cap (config `mcp.maxConcurrent`). */
export const DEFAULT_MCP_MAX_CONCURRENT = 4;

/**
 * The retained-runtime configuration seam. `meta:mcp` provides the concrete
 * command registry and a runtime layer that satisfies every dispatched command;
 * tests provide synthetic specs and a minimal layer.
 */
export interface McpRuntimeConfigShape {
  readonly commandEntries: ReadonlyArray<McpCommandEntry>;
  readonly toolingEntries?: ReadonlyArray<McpCommandEntry>;
  readonly defaultAllowlist: ReadonlyArray<string>;
  /**
   * Layer providing every service a dispatched command needs (Renderer,
   * StreamFrameSink, app services). Built once per `serve` session — the single
   * retained runtime.
   */
  readonly runtimeLayer: Layer.Layer<unknown> | Layer.Layer<never>;
}

export class McpRuntimeConfig extends Context.Tag("@lando/core/McpRuntimeConfig")<
  McpRuntimeConfig,
  McpRuntimeConfigShape
>() {}

export interface McpServiceShape {
  /**
   * Run the retained-runtime dispatch loop against the provided `McpTransport`
   * until the transport closes. Bounded concurrency, non-interactive dispatch,
   * and scope-finalizing cancellation are enforced here.
   */
  readonly serve: (options: McpServeOptions) => Effect.Effect<void, McpTransportError, McpTransport>;
  /** The effective tool catalog — the `lando mcp --list` shape. */
  readonly catalog: (options?: McpCatalogOptions) => Effect.Effect<McpCatalog>;
}

export class McpService extends Context.Tag("@lando/core/McpService")<McpService, McpServiceShape>() {}

const makeService = (
  config: McpRuntimeConfigShape,
  redaction: Context.Tag.Service<typeof RedactionService>,
  events: Option.Option<Context.Tag.Service<typeof EventService>>,
): McpServiceShape => {
  const publish: ((event: LandoEvent) => Effect.Effect<void>) | undefined = Option.isSome(events)
    ? (event) => events.value.publish(event).pipe(Effect.catchAll(() => Effect.void))
    : undefined;
  const allowWithTooling = (allow: ReadonlyArray<string> | undefined, tooling: boolean | undefined) =>
    tooling === true
      ? [...(allow ?? []), ...(config.toolingEntries ?? []).map((entry) => entry.spec.id)]
      : allow;

  const catalog: McpServiceShape["catalog"] = (options) =>
    Effect.sync(() =>
      buildCatalog({
        commandEntries: config.commandEntries,
        ...(config.toolingEntries === undefined ? {} : { toolingEntries: config.toolingEntries }),
        effective: computeEffectiveAllowlist({
          defaults: config.defaultAllowlist,
          allow: allowWithTooling(options?.allow, options?.tooling),
          deny: options?.deny,
        }),
        ...(options === undefined ? {} : { options }),
      }),
    );

  const serve: McpServiceShape["serve"] = (options) =>
    Effect.gen(function* () {
      const transport = yield* McpTransport;
      // Effect.scoped bounds the session: transport close (or an interrupt of
      // the serve fiber) closes this scope, interrupting in-flight fibers and
      // finalizing the retained runtime.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const redactor = yield* redaction.forProfile("secrets", { sourceEnv: process.env });
          const semaphore = yield* Effect.makeSemaphore(options.maxConcurrent ?? DEFAULT_MCP_MAX_CONCURRENT);
          const effective = computeEffectiveAllowlist({
            defaults: config.defaultAllowlist,
            allow: allowWithTooling(options.allow, options.tooling),
            deny: options.deny,
          });
          const registry = new Map<string, McpCommandEntry>(
            (options.tooling === true
              ? [...config.commandEntries, ...(config.toolingEntries ?? [])]
              : config.commandEntries
            ).map((entry) => [entry.spec.id, entry]),
          );
          const runtimeContext = yield* Layer.build(config.runtimeLayer);
          const inFlight = yield* Ref.make(new Map<string, Fiber.RuntimeFiber<void, McpTransportError>>());
          const canceledBeforeStart = yield* Ref.make(new Set<string>());
          const completed = yield* Ref.make(emptyCompletedRequestIds());
          const notifyFor =
            (incoming: McpTransportRequest): McpNotify =>
            (frame) =>
              transport.notify({ id: incoming.id, frame });
          const encodeProgressFrame = (
            frame: unknown,
            redactorForFrame: Redactor,
          ): Effect.Effect<unknown, McpTransportError> =>
            Effect.try({
              try: () => projectMcpProgressFrame(frame),
              catch: (cause) =>
                cause instanceof McpTransportError
                  ? cause
                  : new McpTransportError({
                      message: "MCP progress payload could not be safely inspected.",
                      remediation:
                        "Emit a plain stdout or stderr frame with string chunk and service fields.",
                    }),
            }).pipe(
              Effect.flatMap((projected) =>
                redactBoundedJsonValue(projected, redactorForFrame, "MCP progress payload"),
              ),
            );
          const streamSinkFor = (
            notify: McpNotify,
            redactorForFrame: Redactor,
          ): Context.Tag.Service<typeof StreamFrameSink> => ({
            emit: (frame: StreamFrameSinkFrame) =>
              encodeProgressFrame(frame, redactorForFrame).pipe(Effect.flatMap(notify), Effect.orDie),
          });
          const outcomeFromExit = (
            exit: Exit.Exit<unknown, unknown>,
          ): Effect.Effect<CommandResultOutcome> => {
            if (exit._tag === "Success") {
              return Effect.succeed({ _tag: "success", value: exit.value } satisfies CommandResultOutcome);
            }
            if (Cause.isInterruptedOnly(exit.cause)) return Effect.interrupt;
            return Effect.succeed({
              _tag: "failure",
              error: Cause.squash(exit.cause),
            } satisfies CommandResultOutcome);
          };
          const depsFor = (incoming: McpTransportRequest): McpDispatchDeps => ({
            registry,
            effective: effective.ids,
            allowlistSource: options.tooling === true ? `${effective.source}+tooling` : effective.source,
            redactor,
            execute: (entry, runInput) =>
              Effect.gen(function* () {
                const command = entry.spec.run(runInput);
                const rootAwareCommand =
                  runInput.appPath === undefined
                    ? command
                    : command.pipe(Effect.provideService(RuntimeCwd, runInput.appPath));
                const invocation = yield* makeNestedCommandInvocation(entry.spec.id, {
                  argv: runInput.argv,
                  args: runInput.args,
                  flags: runInput.flags,
                  ...(runInput.appPath === undefined ? {} : { cwd: runInput.appPath }),
                });
                const exit = yield* runCommandLifecycle(rootAwareCommand, {
                  invocation,
                  ...(entry.spec.successExitCode === undefined
                    ? {}
                    : { successExitCode: (value) => entry.spec.successExitCode?.(value, runInput) }),
                });
                return yield* outcomeFromExit(exit);
              }).pipe(
                Effect.provide(runtimeContext),
                Effect.provideService(StreamFrameSink, streamSinkFor(notifyFor(incoming), redactor)),
              ) as Effect.Effect<CommandResultOutcome, never>,
            notify: notifyFor(incoming),
            ...(publish === undefined ? {} : { publish }),
          });

          const completeInFlight = (id: string): Effect.Effect<void> =>
            Ref.update(inFlight, (current) => {
              const next = new Map(current);
              next.delete(id);
              return next;
            }).pipe(
              Effect.zipRight(Ref.update(completed, (current) => rememberCompletedRequestId(current, id))),
            );

          const clearCompleted = (id: string): Effect.Effect<void> =>
            Ref.update(completed, (current) => forgetCompletedRequestId(current, id));

          const takeCanceledBeforeStart = (id: string): Effect.Effect<boolean> =>
            Ref.modify(canceledBeforeStart, (current) => {
              if (!current.has(id)) return [false, current];
              const next = new Set(current);
              next.delete(id);
              return [true, next];
            });

          const handleOne = (incoming: McpTransportRequest) =>
            dispatchTool(incoming.request, depsFor(incoming)).pipe(
              Effect.matchCauseEffect({
                onFailure: (cause) => {
                  const failure = Cause.failureOption(cause);
                  return Option.isSome(failure)
                    ? transport.reply({ id: incoming.id, ok: false, error: failure.value })
                    : replyMcpCanceled(transport, incoming.id);
                },
                onSuccess: (result) => transport.reply({ id: incoming.id, ok: true, result }),
              }),
            );

          const handleCanceledBeforeStart = (incoming: McpTransportRequest) =>
            dispatchTool(incoming.request, { ...depsFor(incoming), execute: () => Effect.interrupt }).pipe(
              Effect.ignore,
              Effect.zipRight(replyMcpCanceled(transport, incoming.id)),
              Effect.zipRight(
                Ref.update(completed, (current) => rememberCompletedRequestId(current, incoming.id)),
              ),
            );

          const forkRequest = (incoming: McpTransportRequest) =>
            Effect.gen(function* () {
              yield* clearCompleted(incoming.id);
              if (yield* takeCanceledBeforeStart(incoming.id)) {
                yield* handleCanceledBeforeStart(incoming);
                return;
              }
              const start = yield* Deferred.make<void>();
              const fiber = yield* semaphore
                .withPermits(1)(
                  Deferred.await(start).pipe(
                    Effect.zipRight(handleOne(incoming)),
                    Effect.ensuring(completeInFlight(incoming.id)),
                  ),
                )
                .pipe(Effect.forkScoped);
              yield* Ref.update(inFlight, (current) => new Map(current).set(incoming.id, fiber));
              yield* Deferred.succeed(start, undefined);
            });

          const cancelRequest = (id: string) =>
            Ref.get(inFlight).pipe(
              Effect.flatMap((current) => {
                const fiber = current.get(id);
                if (fiber !== undefined)
                  return Fiber.interrupt(fiber).pipe(Effect.zipRight(replyMcpCanceled(transport, id)));
                return Ref.get(completed).pipe(
                  Effect.flatMap((done) =>
                    done.has(id)
                      ? Effect.void
                      : Ref.update(canceledBeforeStart, (canceled) => new Set(canceled).add(id)),
                  ),
                );
              }),
            );

          const nextRequest = transport.receive.pipe(
            Effect.map((request) => ({ _tag: "request" as const, request })),
          );
          const nextCancel = transport.receiveCancel.pipe(
            Effect.map((id) => ({ _tag: "cancel" as const, id })),
          );

          while (true) {
            const next = yield* Effect.raceFirst(nextRequest, nextCancel);
            if (next._tag === "request") {
              if (Option.isNone(next.request)) break;
              yield* forkRequest(next.request.value);
            } else {
              if (Option.isNone(next.id)) break;
              yield* cancelRequest(next.id.value);
            }
          }
        }),
      );
    });

  return { serve, catalog };
};

/**
 * `McpServiceLive` — lazy (`Layer.suspend`) so it is constructed only when
 * `meta:mcp` or a library host requests it. Requires the retained-runtime
 * config and `RedactionService`; `EventService` is optional.
 */
export const McpServiceLive: Layer.Layer<McpService, never, McpRuntimeConfig | RedactionService> =
  Layer.suspend(() =>
    Layer.effect(
      McpService,
      Effect.gen(function* () {
        const config = yield* McpRuntimeConfig;
        const redaction = yield* RedactionService;
        const events = yield* Effect.serviceOption(EventService);
        return makeService(config, redaction, events);
      }),
    ),
  );
