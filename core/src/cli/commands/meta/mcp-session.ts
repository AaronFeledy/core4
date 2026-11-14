/**
 * The retained `lando mcp` session: one host runtime plus per-app contribution generations.
 */

import { withAppDiscovery } from "@lando/landofile/operation-discovery";
import type { LandoRuntimeBootstrapError } from "@lando/sdk/errors";
import { type Context, Effect, Layer, type Result } from "effect";
import { CliInvocation } from "../../../runtime/invocation-context";
import type { GenerationHostServices, LandoGenerationRuntime } from "../../../runtime/layer";
import { type McpAppGenerations, makeMcpAppGenerations } from "./mcp-app-generations";
import { eligibleMcpEntries } from "./mcp-plugins";
import { type McpCommandRegistry, knownIdsOf } from "./mcp-registry";
import { readMcpToolingCatalog } from "./mcp-tooling-catalog";

export interface McpSession {
  readonly host: Context.Context<GenerationHostServices>;
  readonly apps: McpAppGenerations;
}

export const openMcpSession = Effect.fnUntraced(function* (
  runtimeResult: Result.Result<LandoGenerationRuntime, LandoRuntimeBootstrapError>,
  builtIns: McpCommandRegistry,
) {
  const runtime = yield* Effect.fromResult(runtimeResult);
  // A fresh memo map: the host never reuses services the command runtime already built.
  const host = yield* Layer.buildWithMemoMap(runtime.host, Layer.makeMemoMapUnsafe(), yield* Effect.scope);
  const apps = yield* makeMcpAppGenerations({ runtime, host, sessionIds: knownIdsOf(builtIns) });
  return { host, apps } satisfies McpSession;
});

/** The session directory app's catalog inputs: built-ins, its plugin owners, and tooling when on. */
export const sessionAppRegistry = Effect.fnUntraced(function* (
  builtIns: McpCommandRegistry,
  session: McpSession,
  tooling: boolean,
) {
  const { cwd } = yield* CliInvocation;
  return yield* withAppDiscovery(
    cwd,
    Effect.scoped(
      Effect.gen(function* () {
        const generation = yield* session.apps.acquire(cwd);
        const catalog = tooling ? yield* readMcpToolingCatalog(generation) : undefined;
        return {
          commandEntries: [...builtIns.commandEntries, ...eligibleMcpEntries(generation)],
          ...(catalog === undefined
            ? {}
            : { toolingEntries: catalog.entries, toolingUnavailable: catalog.unavailable }),
          generation,
          diagnostics: [...(builtIns.diagnostics ?? []), ...generation.diagnostics],
        } satisfies McpCommandRegistry;
      }),
    ),
  );
});
