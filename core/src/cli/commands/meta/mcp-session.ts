/**
 * The retained `lando mcp` session: one host runtime plus per-app contribution generations.
 * The tooling catalog still comes from the session directory's app at session start.
 */
import { type Context, Effect, Layer, type Result } from "effect";

import { withAppDiscovery } from "@lando/landofile/operation-discovery";
import type { LandoRuntimeBootstrapError } from "@lando/sdk/errors";
import { CommandRegistry } from "@lando/sdk/services";

import type { GenerationHostServices, LandoGenerationRuntime } from "../../../runtime/layer";
import {
  type McpAppGenerationRecord,
  type McpAppGenerations,
  makeMcpAppGenerations,
} from "./mcp-app-generations";
import { eligibleMcpEntries } from "./mcp-plugins";
import { type McpCommandRegistry, knownIdsOf, mcpRegistryWithToolingEntries } from "./mcp-registry";

export interface McpSession {
  readonly host: Context.Context<GenerationHostServices>;
  readonly apps: McpAppGenerations;
  readonly prepareTooling: Effect.Effect<void>;
}

export const openMcpSession = Effect.fnUntraced(function* (
  runtimeResult: Result.Result<LandoGenerationRuntime, LandoRuntimeBootstrapError>,
  builtIns: McpCommandRegistry,
  prepareTooling: Effect.Effect<void>,
) {
  const runtime = yield* Effect.fromResult(runtimeResult);
  // A fresh memo map: the host never reuses services the command runtime already built.
  const host = yield* Layer.buildWithMemoMap(runtime.host, Layer.makeMemoMapUnsafe(), yield* Effect.scope);
  const apps = yield* makeMcpAppGenerations({ runtime, host, sessionIds: knownIdsOf(builtIns) });
  return { host, apps, prepareTooling } satisfies McpSession;
});

const toolingEntriesFor = Effect.fnUntraced(function* (
  session: McpSession,
  generation: McpAppGenerationRecord,
) {
  yield* session.prepareTooling;
  const commands = yield* Effect.flatMap(CommandRegistry, (registry) => registry.list).pipe(
    Effect.provide(generation.context),
  );
  return mcpRegistryWithToolingEntries({ commandEntries: [] }, commands).toolingEntries ?? [];
});

/** The session directory app's catalog inputs: built-ins, its plugin owners, and tooling when on. */
export const sessionAppRegistry = Effect.fnUntraced(function* (
  builtIns: McpCommandRegistry,
  session: McpSession,
  tooling: boolean,
) {
  const cwd = process.cwd();
  return yield* withAppDiscovery(
    cwd,
    Effect.scoped(
      Effect.gen(function* () {
        const generation = yield* session.apps.acquire(cwd);
        return {
          commandEntries: [...builtIns.commandEntries, ...eligibleMcpEntries(generation)],
          ...(tooling ? { toolingEntries: yield* toolingEntriesFor(session, generation) } : {}),
          diagnostics: [...(builtIns.diagnostics ?? []), ...generation.diagnostics],
        } satisfies McpCommandRegistry;
      }),
    ),
  );
});
