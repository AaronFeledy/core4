import { RedactionService } from "@lando/redaction/service";
import type { McpTransportError } from "@lando/sdk/errors";
import type { LandoEvent } from "@lando/sdk/events";
import type { McpCatalog, McpCatalogOptions, McpServeOptions } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";
import { Context, Effect, Layer, Option } from "effect";
import type { Stdio } from "effect/Stdio";
import { buildCatalog, computeEffectiveAllowlist } from "./catalog";
import { type MemoryPressureLevel, handleMemoryPressure } from "./memory-pressure";
import { McpCommandExecutor } from "./port";
import type { McpCommandEntry } from "./registry";
import type { McpResourceEntry } from "./resources";
import { serveSession } from "./session";

export { DEFAULT_MCP_MAX_CONCURRENT } from "./stdio-limits";
export type { McpResourceEntry } from "./resources";

export interface McpRuntimeConfigShape {
  readonly commandEntries: ReadonlyArray<McpCommandEntry>;
  readonly toolingEntries?: ReadonlyArray<McpCommandEntry>;
  readonly defaultAllowlist: ReadonlyArray<string>;
  readonly runtimeLayer: Layer.Layer<unknown> | Layer.Layer<never>;
  readonly resources?: ReadonlyArray<McpResourceEntry>;
  readonly version?: string;
}

export class McpRuntimeConfig extends Context.Service<McpRuntimeConfig, McpRuntimeConfigShape>()(
  "@lando/mcp/McpRuntimeConfig",
) {}

export interface McpServiceShape {
  readonly serve: (options: McpServeOptions) => Effect.Effect<void, McpTransportError, Stdio>;
  readonly catalog: (options?: McpCatalogOptions) => Effect.Effect<McpCatalog>;
  readonly handleMemoryPressure: (level: MemoryPressureLevel) => void;
}

export class McpService extends Context.Service<McpService, McpServiceShape>()("@lando/mcp/McpService") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const config = yield* McpRuntimeConfig;
      const redaction = yield* RedactionService;
      const executor = yield* McpCommandExecutor;
      const events = yield* Effect.serviceOption(EventService);
      const catalogCache = new Map<string, McpCatalog>();
      const publish: ((event: LandoEvent) => Effect.Effect<void>) | undefined = Option.isSome(events)
        ? (event) => events.value.publish(event).pipe(Effect.ignore)
        : undefined;
      const effective = (options?: McpCatalogOptions) =>
        computeEffectiveAllowlist({
          defaults: config.defaultAllowlist,
          allow:
            options?.tooling === true
              ? [...(options.allow ?? []), ...(config.toolingEntries ?? []).map((entry) => entry.spec.id)]
              : options?.allow,
          deny: options?.deny,
        });
      const catalog: McpServiceShape["catalog"] = (options) =>
        Effect.sync(() => {
          const key = JSON.stringify(options ?? {});
          const cached = catalogCache.get(key);
          if (cached !== undefined) return cached;
          const value = buildCatalog({
            commandEntries: config.commandEntries,
            toolingEntries: config.toolingEntries,
            effective: effective(options),
            options,
          });
          catalogCache.set(key, value);
          return value;
        });
      const onMemoryPressure = (level: MemoryPressureLevel) =>
        handleMemoryPressure(level, {
          dropCaches: () => catalogCache.clear(),
          closeIdleSockets: () => {},
        });
      const serve = Effect.fn("McpService.serve")(function* (options: McpServeOptions) {
        const redactor = yield* redaction.forProfile("secrets", { sourceEnv: process.env });
        const allowlist = effective(options);
        const entries =
          options.tooling === true
            ? [...config.commandEntries, ...(config.toolingEntries ?? [])]
            : config.commandEntries;
        yield* serveSession({
          config,
          options,
          catalog: yield* catalog(options),
          executor,
          redactor,
          handleMemoryPressure: onMemoryPressure,
          deps: {
            registry: new Map(entries.map((entry) => [entry.spec.id, entry])),
            effective: allowlist.ids,
            allowlistSource: options.tooling === true ? `${allowlist.source}+tooling` : allowlist.source,
            redactor,
            ...(publish === undefined ? {} : { publish }),
          },
        });
      });
      return McpService.of({ serve, catalog, handleMemoryPressure: onMemoryPressure });
    }),
  );
}
