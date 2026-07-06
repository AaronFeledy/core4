import { Context, type Effect } from "effect";

import type { EventError, ToolingExecError } from "../errors/index.ts";
import type { AppPlan } from "../schema/index.ts";
import type { ProviderError, RuntimeProviderShape } from "./provider.ts";

/**
 * Renderer — CLI output strategy.
 *
 * Every user-facing message flows through the `message` contract rather than
 * `console.log`; each renderer formats `info`/`warn`/`error` for its own
 * output mode (human glyphs, NDJSON, verbose payload trace).
 *
 * The `output` channel is the raw, unformatted escape hatch for command
 * *results* (already-formatted strings — tables, `--format=json` documents)
 * and process-level diagnostics. Unlike `message.*`, it performs no glyph or
 * newline injection: results go to `output.stdout`, failure diagnostics go to
 * `output.stderr`, regardless of the active mode.
 */
export class Renderer extends Context.Tag("@lando/core/Renderer")<
  Renderer,
  {
    readonly id: string;
    readonly message: {
      readonly info: (body: string) => Effect.Effect<void, EventError>;
      readonly warn: (body: string) => Effect.Effect<void, EventError>;
      readonly error: (body: string, remediation?: string) => Effect.Effect<void, EventError>;
    };
    readonly output: {
      readonly stdout: (chunk: string) => Effect.Effect<void>;
      readonly stderr: (chunk: string) => Effect.Effect<void>;
    };
  }
>() {}

/**
 * Telemetry — optional usage stats. Off by default in CLI mode; off by
 * default in library mode.
 */
export class Telemetry extends Context.Tag("@lando/core/Telemetry")<
  Telemetry,
  {
    readonly enabled: boolean;
    readonly record: (event: string, data: Readonly<Record<string, unknown>>) => Effect.Effect<void, never>;
  }
>() {}

/**
 * A normalized tooling invocation passed to a `ToolingEngine`.
 *
 * The compiler converts a parsed Landofile `tooling.<name>` task plus any
 * pass-through CLI args into one or more provider exec calls. The engine
 * does not see `cmd:` / `cmds:` / shell-wrapping rules directly — only the
 * argv form it should hand to `RuntimeProvider.exec` (or its host
 * equivalent). The order of `commands` is significant; engines execute
 * them sequentially and stop at the first non-zero exit code.
 */
export interface ToolingInvocation {
  /** Tooling task name (the Landofile `tooling.<name>` key). */
  readonly tool: string;
  /** Optional declared service from the task; falls back to primary. */
  readonly service?: string;
  /** Optional unix user to execute as. */
  readonly user?: string;
  /** Optional working directory inside the service. */
  readonly cwd?: string;
  /** Optional environment overlay applied to every command. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Resolved host agent-context env allowlist to forward beneath the service
   * and task env. Omitted falls back to the built-in allowlist; an empty array
   * disables forwarding (opt-out / off-switch).
   */
  readonly agentEnvAllowlist?: ReadonlyArray<string>;
  /** Pre-normalized argv forms, executed in order. */
  readonly commands: ReadonlyArray<ReadonlyArray<string>>;
}

/**
 * Result of executing a tooling invocation: the exit code of the last
 * command that ran plus the aggregated stdout/stderr captured across all
 * commands.
 */
export interface ToolingEngineResult {
  readonly tool: string;
  readonly service: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * ToolingEngine — translate a tooling invocation into a sequence of provider
 * operations. Default: `providerExec`.
 *
 * Selection precedence: `tooling.<name>.engine` → Landofile-level
 * `toolingEngine` → global config `toolingEngine` → default `providerExec`.
 *
 * Engines receive a fully-normalized invocation (argv form, resolved service
 * name still authored as the task `service:` value, etc.) and an `AppPlan`
 * for any plan-level data they need (primary-service lookup, provider id).
 */
export class ToolingEngine extends Context.Tag("@lando/core/ToolingEngine")<
  ToolingEngine,
  {
    readonly id: string;
    readonly run: (
      invocation: ToolingInvocation,
      plan: AppPlan,
      provider: RuntimeProviderShape,
    ) => Effect.Effect<ToolingEngineResult, ProviderError | ToolingExecError>;
  }
>() {}

/**
 * SchemaValidator — validate Landofile/manifest data. Default: Effect Schema.
 */
export class SchemaValidator extends Context.Tag("@lando/core/SchemaValidator")<
  SchemaValidator,
  {
    readonly id: string;
  }
>() {}

/**
 * CommandFramework — argv parsing, manifest, help, plugin install commands.
 *
 * Default: OCLIF. Replaceable but not recommended.
 */
export class CommandFramework extends Context.Tag("@lando/core/CommandFramework")<
  CommandFramework,
  {
    readonly id: string;
  }
>() {}
