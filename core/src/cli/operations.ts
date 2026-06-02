/**
 * `@lando/core/cli/operations` — unstable Effect-bearing command invocation API.
 *
 * This subpath is for embedding hosts that want to call the same operations
 * backing supported CLI commands without spawning `lando` or loading OCLIF.
 * It is intentionally unstable and not yet covered by semver guarantees.
 */
import { Cause, Effect, Exit } from "effect";

export interface InvokeOperationOptions<A, E> {
  readonly render?: (result: A) => string | undefined;
  readonly renderError?: (error: E) => string | undefined;
}

export type InvokeOperationResult<A, E> =
  | {
      readonly ok: true;
      readonly value: A;
      readonly output?: string;
    }
  | {
      readonly ok: false;
      readonly error: E;
      readonly output?: string;
    };

export const invokeOperation = <A, E, R>(
  operation: Effect.Effect<A, E, R>,
  options: InvokeOperationOptions<A, E> = {},
): Effect.Effect<InvokeOperationResult<A, E>, never, R> =>
  Effect.map(Effect.exit(operation), (exit) => {
    if (Exit.isSuccess(exit)) {
      const output = options.render?.(exit.value);
      return {
        ok: true,
        value: exit.value,
        ...(output === undefined ? {} : { output }),
      };
    }

    // Only treat the exit as a host-consumable typed failure when the Cause
    // is *exclusively* a typed failure. Mixed causes (typed failure + defect
    // or interrupt) are propagated as defects so callers never silently lose
    // defect / interrupt information.
    const failure = Cause.failureOption(exit.cause);
    const hasDefect = Cause.dieOption(exit.cause)._tag === "Some";
    const hasInterrupt = Cause.isInterrupted(exit.cause);
    if (failure._tag === "Some" && !hasDefect && !hasInterrupt) {
      const output = options.renderError?.(failure.value);
      return {
        ok: false,
        error: failure.value,
        ...(output === undefined ? {} : { output }),
      };
    }

    throw new Error(Cause.pretty(exit.cause));
  });

export * from "./commands/start.ts";
export * from "./commands/stop.ts";
export * from "./commands/info.ts";
export * from "./commands/destroy.ts";
export * from "./commands/list.ts";
export * from "./commands/logs.ts";
export * from "./commands/exec.ts";
export * from "./commands/shell.ts";
export * from "./commands/rebuild.ts";
export * from "./commands/restart.ts";
export * from "./commands/poweroff.ts";
export * from "./commands/config.ts";
export * from "./commands/meta/global-install.ts";
export * from "./commands/app-config.ts";
export * from "./commands/app-config-lint.ts";
export * from "./commands/app-includes-update.ts";
export * from "./commands/app-cache-refresh.ts";
export * from "./commands/version.ts";
export * from "./commands/update.ts";
export * from "./commands/tooling.ts";
export * from "./commands/scratch.ts";
