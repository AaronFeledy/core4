import { withAppDiscovery } from "@lando/landofile/operation-discovery";
import { RedactionService } from "@lando/redaction/service";
import type { McpTransportError } from "@lando/sdk/errors";
import type { LandoEvent } from "@lando/sdk/events";
import type { McpCatalog, McpCatalogOptions, McpServeOptions } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";
import { Context, Effect, Layer, Option } from "effect";
import type { Stdio } from "effect/Stdio";
import { filterMcpDefaultAllowlist } from "./allowlist";
import {
  type McpAppGeneration,
  type McpAppGenerationFailure,
  type McpAppGenerationsSource,
  generationEntries,
} from "./apps";
import {
  type McpAllowPolicy,
  computeEffectiveAllowlist,
  isMcpEntryAuthorized,
  makeMcpAllowPolicy,
  toDescriptor,
} from "./catalog";
import { type MemoryPressureLevel, handleMemoryPressure } from "./memory-pressure";
import { McpCommandExecutor } from "./port";
import type { McpCommandEntry } from "./registry";
import type { McpResourceEntry } from "./resources";
import { serveSession } from "./session";

export type { McpResourceEntry } from "./resources";
export { DEFAULT_MCP_MAX_CONCURRENT } from "./stdio-limits";

export interface McpRuntimeConfigShape {
  readonly commandEntries: ReadonlyArray<McpCommandEntry>;
  readonly toolingEntries?: ReadonlyArray<McpCommandEntry>;
  readonly defaultAllowlist: ReadonlyArray<string>;
  readonly resources?: ReadonlyArray<McpResourceEntry>;
  readonly version?: string;
  /**
   * Per-app contribution generations, opened once per session. `commandEntries` holds only
   * session-wide owners (built-ins); every call runs in its target app's generation, and plugin
   * command owners come from that generation.
   */
  readonly apps: McpAppGenerationsSource;
}

/** Catalog inputs: the `--list` options plus the directory whose app contributes plugin tools. */
export type McpServiceCatalogOptions = McpCatalogOptions & { readonly cwd?: string };

/** Session-wide owners for `options`, built-ins first; tooling entries only when tooling is on. */
const sessionEntries = (
  config: McpRuntimeConfigShape,
  options: McpCatalogOptions | undefined,
): ReadonlyArray<McpCommandEntry> =>
  options?.tooling === true
    ? [...config.commandEntries, ...(config.toolingEntries ?? [])]
    : config.commandEntries;

/** The session allow policy; tooling ids join `allow` when tooling is on. */
const sessionAllowPolicy = (
  config: McpRuntimeConfigShape,
  options: McpCatalogOptions | undefined,
): McpAllowPolicy =>
  makeMcpAllowPolicy({
    defaults: config.defaultAllowlist,
    allow:
      options?.tooling === true
        ? [...(options.allow ?? []), ...(config.toolingEntries ?? []).map((entry) => entry.spec.id)]
        : options?.allow,
    deny: options?.deny,
  });

const catalogOf = (entries: ReadonlyArray<McpCommandEntry>, policy: McpAllowPolicy): McpCatalog => ({
  tools: entries
    .filter((entry) => isMcpEntryAuthorized(policy, entry))
    .map((entry) => toDescriptor(entry.spec))
    .sort((left, right) => left.toolId.localeCompare(right.toolId)),
});

export class McpRuntimeConfig extends Context.Service<McpRuntimeConfig, McpRuntimeConfigShape>()(
  "@lando/mcp/McpRuntimeConfig",
) {}

export interface McpServiceShape {
  readonly serve: (options: McpServeOptions) => Effect.Effect<void, McpTransportError, Stdio>;
  /** The catalog for one app: session-wide owners plus the plugin owners `cwd`'s app selects. */
  readonly catalog: (
    options?: McpServiceCatalogOptions,
  ) => Effect.Effect<McpCatalog, McpAppGenerationFailure>;
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
      // Keyed by generation identity, so two apps (or a superseded selection) never share a catalog.
      let generationCatalogs = new WeakMap<McpAppGeneration, Map<string, McpCatalog>>();
      const publish: ((event: LandoEvent) => Effect.Effect<void>) | undefined = Option.isSome(events)
        ? (event) => events.value.publish(event).pipe(Effect.ignore)
        : undefined;
      const catalog: McpServiceShape["catalog"] = Effect.fn("McpService.catalog")(function* (
        catalogOptions?: McpServiceCatalogOptions,
      ) {
        const { cwd, ...options } = catalogOptions ?? {};
        const key = JSON.stringify(options);
        const entries = sessionEntries(config, options);
        const policy = sessionAllowPolicy(config, options);
        const directory = cwd ?? process.cwd();
        const generation = yield* withAppDiscovery(
          directory,
          Effect.scoped(Effect.flatMap(config.apps, (apps) => apps.acquire(directory))),
        );
        const sessionIds = new Set(entries.map((entry) => entry.spec.id));
        return yield* Effect.sync(() => {
          const cache = generationCatalogs.get(generation) ?? new Map<string, McpCatalog>();
          generationCatalogs.set(generation, cache);
          const hit = cache.get(key);
          if (hit !== undefined) return hit;
          const value = catalogOf([...entries, ...generationEntries(generation, sessionIds)], policy);
          cache.set(key, value);
          return value;
        });
      });
      const onMemoryPressure = (level: MemoryPressureLevel) =>
        handleMemoryPressure(level, {
          dropCaches: () => {
            generationCatalogs = new WeakMap();
          },
          closeIdleSockets: () => {},
        });
      const serve = Effect.fn("McpService.serve")(function* (options: McpServeOptions) {
        const sourceEnv = { ...process.env };
        const resultRedactor = (tokens: ReadonlyArray<string>) =>
          redaction.forProfile("secrets", { sourceEnv, authoritativeTokens: tokens });
        const redactor = yield* resultRedactor([]);
        const bodyRedactor = yield* redaction.forProfile("secrets", {
          sourceEnv,
          excludeWholeTokenValues: true,
        });
        const payloadValues = yield* redaction.payloadValues({ sourceEnv });
        const policy = sessionAllowPolicy(config, options);
        const allowlist = computeEffectiveAllowlist({
          defaults: filterMcpDefaultAllowlist(config.defaultAllowlist, config.commandEntries),
          allow: [...policy.allow],
          deny: [...policy.deny],
        });
        const entries = sessionEntries(config, options);
        yield* serveSession({
          config,
          options,
          entries,
          policy,
          executor,
          redactor,
          bodyRedactor,
          payloadValues,
          handleMemoryPressure: onMemoryPressure,
          deps: {
            registry: new Map(entries.map((entry) => [entry.spec.id, entry])),
            effective: allowlist.ids,
            allowlistSource: options.tooling === true ? `${allowlist.source}+tooling` : allowlist.source,
            redactor,
            resultRedactor,
            ...(publish === undefined ? {} : { publish }),
          },
        }).pipe(Effect.provideService(RedactionService, redaction));
      });
      return McpService.of({ serve, catalog, handleMemoryPressure: onMemoryPressure });
    }),
  );
}
