import type { Effect, Schema } from "effect";

import type { BootstrapLevel } from "../schema/primitives.ts";

/** Built-in command namespaces (`app`, `apps`, `meta`). */
export type ExecutableCommandCoreNamespace = "app" | "apps" | "meta";

/**
 * Core namespace or a plugin-owned command topic prefix.
 * The `(string & {})` arm preserves literal completion for core namespaces.
 */
export type ExecutableCommandNamespace = ExecutableCommandCoreNamespace | (string & {});

export type ExecutableCommandValue = string | number | boolean;

export interface ExecutableCommandFlagSpec {
  readonly type: "boolean" | "option" | "string" | "number";
  readonly description?: string;
  readonly valueType?: "string" | "integer";
  readonly required?: boolean;
  readonly default?: ExecutableCommandValue | undefined;
  readonly multiple?: boolean;
  readonly options?: ReadonlyArray<string>;
  /**
   * Optional per-value parser.
   *
   * Invoked once per supplied scalar occurrence after primitive conversion
   * (string / number / boolean) and before options validation. May return a
   * value synchronously or via `Promise`. A throw or rejection surfaces as
   * `CommandInputValidationError`.
   */
  readonly parse?: (input: string) => unknown | Promise<unknown>;
}

export interface ExecutableCommandArgSpec {
  readonly type: "option" | "string";
  readonly description?: string;
  readonly valueType?: "string" | "integer";
  readonly required?: boolean;
  readonly default?: ExecutableCommandValue | undefined;
  readonly options?: ReadonlyArray<string>;
  readonly multiple?: boolean;
}

export interface ExecutableCommandInput {
  readonly argv: ReadonlyArray<string>;
  readonly parsedArgv: ReadonlyArray<string>;
  readonly flags: Readonly<Record<string, unknown>>;
  readonly args: Readonly<Record<string, unknown>>;
}

/**
 * Framework-neutral render hook context for plugin/tooling command specs.
 * Carries the validated input, command result, and captured process streams.
 */
export interface ExecutableCommandRenderContext<A = unknown, Input = ExecutableCommandInput> {
  readonly input: Input;
  readonly result: A;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Framework-neutral executable command contract implemented by plugin command modules. */
export interface ExecutableCommandSpec<
  A = unknown,
  E = unknown,
  R = unknown,
  Input = ExecutableCommandInput,
> {
  readonly id: string;
  readonly summary: string;
  readonly namespace: ExecutableCommandNamespace;
  readonly bootstrap: BootstrapLevel;
  readonly flags?: Readonly<Record<string, ExecutableCommandFlagSpec>>;
  readonly args?: Readonly<Record<string, ExecutableCommandArgSpec>>;
  readonly strict?: boolean;
  readonly run: (input: Input) => Effect.Effect<A, E, R>;
  readonly resultSchema: Schema.Schema.AnyNoContext;
  readonly successExitCode?: (result: A, input?: Input) => number | undefined;
  /**
   * Optional post-run render hook. Receives the validated input, result, and
   * captured streams; returns an Effect that performs framework-neutral output.
   */
  readonly render?: (context: ExecutableCommandRenderContext<A, Input>) => Effect.Effect<void, E, R>;
  /**
   * Exact secret values to seed RedactionService when encoding the command
   * envelope. Tokens must not be required fields on resultSchema.
   */
  readonly redactionTokens?: (result: A) => ReadonlyArray<string>;
}

export type ExecutableCommandLoader = () => Promise<ExecutableCommandSpec>;
