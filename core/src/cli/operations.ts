/**
 * `@lando/core/cli/operations` — unstable Effect-bearing command invocation API.
 *
 * This subpath is for embedding hosts that want to call the same operations
 * backing supported CLI commands without spawning `lando` or loading OCLIF.
 * It is intentionally unstable and not yet covered by semver guarantees.
 */
import { Cause, Effect, Exit } from "effect";

import {
  type ProjectedFailure,
  failureOutcomeFromCause,
  primaryFailureReason,
} from "@lando/sdk/command-result";

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
      readonly additionalErrors: ProjectedFailure["additionalErrors"];
      readonly output?: string;
    };

export const invokeOperation = <A, E, R>(
  operation: Effect.Effect<A, E, R>,
  options: InvokeOperationOptions<A, E> = {},
): Effect.Effect<InvokeOperationResult<A, E>, never, R> =>
  Effect.flatMap(Effect.exit(operation), (exit): Effect.Effect<InvokeOperationResult<A, E>> => {
    if (Exit.isSuccess(exit)) {
      const output = options.render?.(exit.value);
      return Effect.succeed({
        ok: true as const,
        value: exit.value,
        ...(output === undefined ? {} : { output }),
      });
    }

    // Typed failures use the shared primary/additional projection; only untyped causes propagate as defects.
    const primary = primaryFailureReason(exit.cause);
    if (primary !== undefined && Cause.isFailReason(primary)) {
      const output = options.renderError?.(primary.error);
      return Effect.succeed({
        ok: false as const,
        error: primary.error,
        additionalErrors: failureOutcomeFromCause(exit.cause).additionalErrors,
        ...(output === undefined ? {} : { output }),
      });
    }

    return Effect.orDie(Effect.failCause(exit.cause));
  });

export * from "@lando/engine/operations/start";
export * from "./commands/start-result";
export * from "@lando/engine/operations/stop";
export * from "./commands/stop";
export * from "@lando/engine/operations/info";
export * from "./commands/info-render";
export * from "@lando/engine/operations/destroy";
export * from "./commands/destroy";
export * from "./commands/list";
export * from "@lando/engine/operations/logs";
export * from "./commands/logs";
export * from "@lando/engine/operations/exec";
export * from "./commands/exec";
export * from "./commands/shell";
export * from "@lando/engine/operations/rebuild";
export * from "./commands/rebuild";
export * from "@lando/engine/operations/restart";
export * from "./commands/restart";
export * from "@lando/engine/operations/remote";
export * from "./commands/remote";
export * from "@lando/engine/operations/share";
export * from "./commands/share";
export * from "./commands/poweroff";
export * from "@lando/engine/operations/config";
export * from "./commands/config";
export * from "@lando/engine/operations/global-install";
export * from "./commands/meta/global-install";
export * from "./commands/app-config";
export * from "@lando/engine/operations/app-config-lint";
export * from "./commands/app-config-explain";
export * from "./commands/app-config-migrate";
export * from "./commands/app-config-lint";
export * from "./commands/app-config-translate";
export * from "./commands/app-includes-update";
export * from "./commands/app-includes-verify";
export * from "./commands/agent-skills";
export * from "./commands/app-cache-refresh";
export * from "./commands/version";
export * from "@lando/engine/operations/update";
export * from "@lando/engine/operations/tooling";
export * from "./commands/tooling";
export * from "./commands/scratch";
