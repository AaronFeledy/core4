import { Schema } from "effect";

import type { ExecutableCommandSpec } from "@lando/sdk/plugins";
import type { DeprecationNotice, StreamFrameSchema } from "@lando/sdk/schema";

import { assertTopLevelAliasesClaimable } from "@lando/engine/operations/reserved-aliases";
import { assertMcpAllowlistSafe } from "@lando/mcp/allowlist";
import { assertHostProxyAllowlistSafe } from "../allowlists/host-proxy";
import { type BugReportContext, type RendererMode, formatBugReport } from "../bug-report";
import type { DeferredCommandPlan } from "../deferred-commands";
import type { RenderContext, StreamOutputFrame } from "../renderer-boundary";

export type LandoCommandNamespace = "app" | "apps" | "meta";

/**
 * Top-level alias rules.
 *
 *   - `false` (default): no top-level alias is registered.
 *   - `true`: register the canonical id with its namespace prefix stripped.
 *     `app:start` → `lando start`. `meta:plugin:add` → `lando plugin:add`.
 *   - `"name"`: register the given name as the top-level alias instead of
 *     the auto-derived name. Multi-segment values like `"plugin:add"` are
 *     accepted.
 *   - `{ name, deprecated }`: register an alias with its own deprecation notice.
 *   - `["a", { name, deprecated }]`: register multiple top-level aliases.
 */
export type LandoAliasSpec = string | { readonly name: string; readonly deprecated?: DeprecationNotice };
export type LandoTopLevelAlias = boolean | LandoAliasSpec | ReadonlyArray<LandoAliasSpec>;

const isAliasArray = (value: LandoTopLevelAlias): value is ReadonlyArray<LandoAliasSpec> =>
  Array.isArray(value);

export interface LandoCommandSpec<A = unknown, E = unknown, R = unknown>
  extends Omit<ExecutableCommandSpec<A, E, R, unknown>, "namespace" | "render" | "successExitCode"> {
  readonly namespace: LandoCommandNamespace;
  readonly description?: string;
  readonly deprecated?: DeprecationNotice;
  /** True only for commands exposed as MCP tools by default; destructive surfaces must not set this. */
  readonly mcpAllowed?: boolean;
  /** True only for commands safe to forward from inside a container via the in-container `lando` shim. */
  readonly hostProxyAllowed?: boolean;
  readonly topLevelAlias?: LandoTopLevelAlias;
  readonly aliases?: ReadonlyArray<LandoAliasSpec>;
  readonly examples?: ReadonlyArray<string>;
  readonly hidden?: boolean;
  readonly deferred?: DeferredCommandPlan;
  /** Present only for commands that stream incremental output (logs/exec/build). */
  readonly streaming?: StreamFrameSchema;
  readonly streamingMode?: "live" | ((input: unknown) => "live" | undefined);
  readonly streamFrames?: (result: unknown) => ReadonlyArray<StreamOutputFrame>;
  readonly redactionTokens?: (result: unknown) => ReadonlyArray<string>;
  /**
   * Core CLI string render hook. Omitted from the SDK Effect union and
   * redeclared here so built-in call sites keep `RenderContext` and a
   * `string | undefined` return (no Effect leakage).
   */
  readonly render?: {
    bivarianceHack(result: unknown, input?: unknown, ctx?: RenderContext): string | undefined;
  }["bivarianceHack"];
  readonly successExitCode?: {
    bivarianceHack(result: A, input?: unknown): number | undefined;
  }["bivarianceHack"];
  readonly suppressDeprecationDiagnostics?: (input: unknown) => boolean;
}

export type {
  ExecutableCommandInput,
  ExecutableCommandNamespace,
  ExecutableCommandRenderContext,
  ExecutableCommandSpec,
  ExecutableCommandValue,
} from "@lando/sdk/plugins";

export const EmptyResultSchema = Schema.Struct({});

export class CommandRegistrationError extends Schema.TaggedError<CommandRegistrationError>()(
  "CommandRegistrationError",
  {
    message: Schema.String,
    commandId: Schema.optional(Schema.String),
    remediation: Schema.optional(Schema.String),
  },
) {}

export const validateCommandSpec = (spec: {
  readonly id: string;
  readonly resultSchema?: unknown;
  readonly mcpAllowed?: boolean;
  readonly hostProxyAllowed?: boolean;
  readonly topLevelAlias?: LandoTopLevelAlias;
  readonly aliases?: ReadonlyArray<LandoAliasSpec>;
}): void => {
  if (spec.resultSchema === undefined || spec.resultSchema === null) {
    throw new CommandRegistrationError({
      message: `Command ${spec.id} does not declare a resultSchema. Every command must declare the machine-readable shape of its result; use EmptyResultSchema for a command with no payload.`,
      commandId: spec.id,
      remediation: "Add a `resultSchema` to the command spec.",
    });
  }
  assertMcpAllowlistSafe(spec);
  assertHostProxyAllowlistSafe(spec);
  assertTopLevelAliasesClaimable(
    spec.id,
    resolveTopLevelAliases({
      id: spec.id,
      ...(spec.topLevelAlias === undefined ? {} : { topLevelAlias: spec.topLevelAlias }),
      ...(spec.aliases === undefined ? {} : { aliases: spec.aliases }),
    }),
  );
};

export const isCanonicalLandoCommandId = (commandId: string): boolean => /^(app|apps|meta):/.test(commandId);

export const formatCommandError = (input: {
  readonly error: unknown;
  readonly commandId: string;
  readonly rendererMode: RendererMode;
}): string => {
  const context: BugReportContext = { commandId: input.commandId };
  return formatBugReport({ error: input.error, context, rendererMode: input.rendererMode });
};

export const extractSpecAbortSignal = (input: unknown): AbortSignal | undefined =>
  typeof input === "object" && input !== null && "signal" in input && input.signal instanceof AbortSignal
    ? input.signal
    : undefined;

export const resolveTopLevelAliases = (
  spec: Pick<LandoCommandSpec, "id" | "topLevelAlias" | "aliases">,
): ReadonlyArray<string> => {
  const explicit = (spec.aliases ?? []).map((alias) => (typeof alias === "string" ? alias : alias.name));
  const top = spec.topLevelAlias;

  if (top === false || top === undefined) {
    return explicit;
  }

  if (top === true) {
    const stripped = spec.id.replace(/^[^:]+:/, "");
    return Array.from(new Set([...explicit, stripped]));
  }

  if (typeof top === "string") {
    return Array.from(new Set([...explicit, top]));
  }

  if (!isAliasArray(top)) {
    return Array.from(new Set([...explicit, top.name]));
  }

  return Array.from(
    new Set([...explicit, ...top.map((alias) => (typeof alias === "string" ? alias : alias.name))]),
  );
};
