/**
 * Per-app contribution generations, the port a retained MCP host implements.
 *
 * Every tool call resolves its effective directory (`appPath` against the session directory)
 * and leases that app's generation for the whole call. A generation carries the service context
 * the call runs in and the command owners its plugin selection contributes, so selection,
 * validation, authorization, execution, and result encoding all read one owner.
 */
import { resolve } from "node:path";

import type { OperationDiscovery } from "@lando/landofile/operation-discovery";
import { Context, Effect, type Scope } from "effect";

import type { McpCommandEntry } from "./registry";

/** One command id's owner in a generation: projected for MCP, or failed while loading. */
export type McpGenerationCommand =
  | { readonly _tag: "Eligible"; readonly entry: McpCommandEntry }
  | { readonly _tag: "Failed"; readonly commandId: string; readonly error: unknown };

export interface McpAppGeneration {
  /** Canonical app root the selection belongs to, or the directory itself outside any app. */
  readonly key: string;
  /** Services the call runs with; plugin-dependent services come from this app's selection. */
  readonly context: Context.Context<unknown>;
  /** Plugin command owners this app selects, keyed by canonical id. */
  readonly commands: ReadonlyMap<string, McpGenerationCommand>;
}

/** Why a generation could not be acquired: the selected app's own tagged failure. */
export interface McpAppGenerationFailure {
  readonly _tag: string;
  readonly message: string;
}

export interface McpAppGenerationsShape {
  /**
   * Lease the generation for an effective call directory until the surrounding scope closes.
   * App discovery reads the caller's operation memo, so one call resolves its app root once for
   * acquisition, selection, binding, and execution.
   */
  readonly acquire: (
    cwd: string,
  ) => Effect.Effect<McpAppGeneration, McpAppGenerationFailure, Scope.Scope | OperationDiscovery>;
}

/** Opens a session's generations; resources it acquires live until the session scope closes. */
export type McpAppGenerationsSource = Effect.Effect<McpAppGenerationsShape, never, Scope.Scope>;

/**
 * Generations for a host without app-local plugins: every acquisition directory gets its own
 * generation over the same services and no plugin owners.
 */
export const singleAppGenerations = <Services>(
  services: Context.Context<Services>,
): McpAppGenerationsShape => {
  const context = Context.makeUnsafe<unknown>(services.mapUnsafe);
  const generations = new Map<string, McpAppGeneration>();
  return {
    acquire: (cwd) =>
      Effect.sync(() => {
        const key = resolve(cwd);
        const known = generations.get(key);
        if (known !== undefined) return known;
        const generation: McpAppGeneration = { key, context, commands: new Map() };
        generations.set(key, generation);
        return generation;
      }),
  };
};

/** Eligible plugin owners a generation contributes beyond the session-wide ids. */
export const generationEntries = (
  generation: McpAppGeneration,
  sessionIds: ReadonlySet<string>,
): ReadonlyArray<McpCommandEntry> =>
  [...generation.commands.values()].flatMap((command) =>
    command._tag === "Eligible" && !sessionIds.has(command.entry.spec.id) ? [command.entry] : [],
  );
