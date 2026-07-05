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
import { Cause, Context, Effect, Layer, Option } from "effect";

import type { McpTransportError } from "@lando/sdk/errors";
import type { LandoEvent } from "@lando/sdk/events";
import type { McpCatalog, McpCatalogOptions, McpServeOptions } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";

import type { CommandResultOutcome } from "../cli/result-encode.ts";
import { RedactionService } from "../redaction/service.ts";
import { buildCatalog, computeEffectiveAllowlist } from "./catalog.ts";
import { type McpDispatchDeps, dispatchTool } from "./dispatch.ts";
import type { McpCommandEntry } from "./registry.ts";
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
  readonly runtimeLayer: Layer.Layer<unknown>;
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
  const registry = new Map<string, McpCommandEntry>(
    config.commandEntries.map((entry) => [entry.spec.id, entry] as const),
  );
  const publish: ((event: LandoEvent) => Effect.Effect<void>) | undefined = Option.isSome(events)
    ? (event) => events.value.publish(event).pipe(Effect.catchAll(() => Effect.void))
    : undefined;

  const catalog: McpServiceShape["catalog"] = (options) =>
    Effect.sync(() =>
      buildCatalog({
        commandEntries: config.commandEntries,
        ...(config.toolingEntries === undefined ? {} : { toolingEntries: config.toolingEntries }),
        effective: computeEffectiveAllowlist({
          defaults: config.defaultAllowlist,
          allow: options?.allow,
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
          const maxConcurrent = options.maxConcurrent ?? DEFAULT_MCP_MAX_CONCURRENT;
          const semaphore = yield* Effect.makeSemaphore(maxConcurrent);
          const effective = computeEffectiveAllowlist({
            defaults: config.defaultAllowlist,
            allow: options.allow,
            deny: options.deny,
          });
          const runtimeContext = yield* Layer.build(config.runtimeLayer);
          const deps: McpDispatchDeps = {
            registry,
            effective: effective.ids,
            allowlistSource: effective.source,
            redactor,
            execute: (entry, runInput) =>
              (entry.spec.run(runInput) as Effect.Effect<unknown, unknown, unknown>).pipe(
                Effect.provide(runtimeContext),
                Effect.map((value) => ({ _tag: "success", value }) satisfies CommandResultOutcome),
                Effect.catchAll((error) =>
                  Effect.succeed({ _tag: "failure", error } satisfies CommandResultOutcome),
                ),
              ) as Effect.Effect<CommandResultOutcome, never>,
            ...(publish === undefined ? {} : { publish }),
          };

          const handleOne = (incoming: McpTransportRequest): Effect.Effect<void> =>
            dispatchTool(incoming.request, deps).pipe(
              Effect.matchCauseEffect({
                onFailure: (cause) => {
                  const failure = Cause.failureOption(cause);
                  return Option.isSome(failure)
                    ? transport.reply({ id: incoming.id, ok: false, error: failure.value })
                    : Effect.void;
                },
                onSuccess: (result) => transport.reply({ id: incoming.id, ok: true, result }),
              }),
            );

          while (true) {
            const next = yield* transport.receive;
            if (Option.isNone(next)) break;
            yield* semaphore.withPermits(1)(handleOne(next.value)).pipe(Effect.forkScoped);
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
