/**
 * Per-call owner selection for a retained MCP session.
 *
 * A call leases the generation of its effective directory before admission, then selects the
 * single owner every later stage uses: authorization against that owner's provenance, the
 * advertised-contract check, and execution in that generation's services. A missing owner is an
 * input error on `appPath`; a selected owner that failed to load keeps its own tagged error.
 */
import { ConfirmationPrompt } from "@lando/engine/operations/confirmation-prompt";
import { RuntimeCwd } from "@lando/engine/runtime/cwd";
import type { OperationDiscovery } from "@lando/landofile/operation-discovery";
import { failureOutcomeFromCause, normalizeDefect } from "@lando/sdk/command-result";
import { McpToolInputError, type McpToolNotAllowedError } from "@lando/sdk/errors";
import { Cause, Context, Effect, Option, Scope, type Semaphore } from "effect";

import type { McpAppGenerationsShape } from "./apps";
import { type McpAllowPolicy, isMcpEntryAuthorized, isMcpIdAuthorizable } from "./catalog";
import type { McpDispatchDeps, McpToolSelection } from "./dispatch";
import { mcpToolNotAllowedError } from "./dispatch-outcome";
import { makeNestedExecute } from "./execute";
import type { McpCommandExecutorShape } from "./port";
import type { makeStreamFrameSink } from "./progress";
import type { McpCommandEntry } from "./registry";
import type { McpToolPublication, makeSessionCatalog } from "./session-catalog";

export interface McpCallTarget {
  readonly toolId: string;
  /** Effective directory: `appPath` resolved against the session directory. */
  readonly cwd: string;
  /** True when the call named an app explicitly. */
  readonly explicit: boolean;
  /** Contracts advertised when the call arrived. */
  readonly advertised: ReadonlySet<string>;
  readonly scope: Scope.Scope;
  readonly prompt: Option.Option<Context.Service.Shape<typeof ConfirmationPrompt>>;
  readonly output: ReturnType<typeof makeStreamFrameSink>;
  readonly published: (appPath: string, publication: McpToolPublication) => void;
}

export interface McpCallSelectionDeps {
  readonly apps: McpAppGenerationsShape;
  readonly catalog: Effect.Success<ReturnType<typeof makeSessionCatalog>>;
  readonly policy: McpAllowPolicy;
  readonly sessionOwners: ReadonlyMap<string, McpCommandEntry>;
  readonly deps: Pick<McpDispatchDeps, "effective" | "allowlistSource">;
  readonly executor: McpCommandExecutorShape;
  readonly permits: Semaphore.Semaphore;
}

export const selectCallOwner = Effect.fnUntraced(function* (
  session: McpCallSelectionDeps,
  call: McpCallTarget,
): Effect.fn.Return<McpToolSelection, McpToolInputError | McpToolNotAllowedError, OperationDiscovery> {
  const { toolId } = call;
  // No owner of a denied or never-allowed id can run, so its app is never built.
  const toolingOwner = session.catalog.toolingOwner(toolId);
  if (
    !(toolingOwner === undefined
      ? isMcpIdAuthorizable(session.policy, toolId)
      : isMcpEntryAuthorized(session.policy, toolingOwner))
  )
    return yield* Effect.fail(mcpToolNotAllowedError(toolId, session.deps));
  const leased = yield* Effect.exit(
    session.catalog.refresh(
      Effect.map(Scope.provide(session.apps.acquire(call.cwd), call.scope), (generation) => ({ generation })),
    ),
  );
  if (leased._tag === "Failure") {
    if (Cause.hasInterruptsOnly(leased.cause)) return yield* Effect.interrupt;
    return {
      _tag: "OwnerFailed",
      commandId: toolId,
      outcome: failureOutcomeFromCause(leased.cause, normalizeDefect),
    };
  }
  const { generation, publication } = leased.value;
  call.published(generation.key, publication);
  const sessionOwner = session.sessionOwners.get(toolId) ?? session.catalog.toolingOwner(toolId);
  const owner =
    sessionOwner === undefined
      ? generation.commands.get(toolId)
      : { _tag: "Eligible" as const, entry: sessionOwner };
  if (owner === undefined)
    return yield* new McpToolInputError({
      toolId,
      path: "appPath",
      message: `Tool ${toolId} is unavailable in the selected app (${generation.key}).`,
      remediation: `Pass an appPath whose app provides ${toolId}, or call a tool the selected app provides.`,
    });
  if (owner._tag === "Failed") {
    if (owner.owner === undefined || !isMcpEntryAuthorized(session.policy, owner.owner))
      return yield* Effect.fail(mcpToolNotAllowedError(toolId, session.deps));
    return {
      _tag: "OwnerFailed",
      commandId: owner.commandId,
      outcome: failureOutcomeFromCause(Cause.fail(owner.error), normalizeDefect),
    };
  }
  const entry = owner.entry;
  if (!isMcpEntryAuthorized(session.policy, entry))
    return yield* Effect.fail(mcpToolNotAllowedError(toolId, session.deps));
  if (!call.advertised.has(session.catalog.signatureOf(entry, generation.key)))
    return yield* new McpToolInputError({
      toolId,
      path: "appPath",
      message: `The selected app's ${toolId} contract was not advertised when this call arrived.`,
      remediation: "List tools again (tools/list) to read the updated contract, then retry the call.",
    });
  const callContext = Context.add(generation.context, RuntimeCwd, call.cwd);
  const nested = makeNestedExecute(
    Option.isSome(call.prompt)
      ? Context.add(callContext, ConfirmationPrompt, call.prompt.value)
      : callContext,
    call.output,
    session.executor,
  );
  return {
    _tag: "Selected",
    entry,
    execute: (selected, runInput) =>
      session.permits.withPermits(1)(
        nested(selected, call.explicit ? { ...runInput, appPath: call.cwd } : runInput),
      ),
  };
});
