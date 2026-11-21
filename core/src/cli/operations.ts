/**
 * `@lando/core/cli/operations` — unstable Effect-bearing command invocation API.
 *
 * This subpath is for embedding hosts that want to call the same operations
 * backing supported CLI commands without spawning `lando` or loading OCLIF.
 * It is intentionally unstable and not yet covered by semver guarantees.
 */

import {
  type ProjectedFailure,
  failureDefectCause,
  failureOutcomeFromCause,
} from "@lando/sdk/command-result";
import { Effect, Exit } from "effect";

export interface InvokeOperationOptions<A, E> {
  readonly render?: (result: A) => string | undefined;
  readonly renderError?: (error: E) => string | undefined;
  /** Witness an elected error before exposing it as E. Without a witness it stays on the failure channel. */
  readonly isError?: (error: unknown) => error is E;
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

    const failure = failureOutcomeFromCause(exit.cause);
    if (failure.kind !== "typed") return Effect.failCause(failureDefectCause(exit.cause));
    const error =
      failure.source === "fail"
        ? { value: failure.error }
        : options.isError?.(failure.error)
          ? { value: failure.error }
          : undefined;
    if (error === undefined) return Effect.failCause(failureDefectCause(exit.cause));
    const output = options.renderError?.(error.value);
    return Effect.succeed({
      ok: false as const,
      error: error.value,
      additionalErrors: failure.additionalErrors,
      ...(output === undefined ? {} : { output }),
    });
  });

export * from "@lando/engine/operations/app-config-lint";
export * from "@lando/engine/operations/config";
export * from "@lando/engine/operations/destroy";
export * from "@lando/engine/operations/exec";
export * from "@lando/engine/operations/global-destroy";
export * from "@lando/engine/operations/global-install";
export * from "@lando/engine/operations/global-list";
export * from "@lando/engine/operations/global-policy";
export * from "@lando/engine/operations/global-rebuild";
export * from "@lando/engine/operations/global-restart";
export * from "@lando/engine/operations/global-start";
export * from "@lando/engine/operations/global-stop";
export * from "@lando/engine/operations/info";
export * from "@lando/engine/operations/logs";
export * from "@lando/engine/operations/logs-build";
export * from "@lando/engine/operations/rebuild";
export * from "@lando/engine/operations/remote";
export * from "@lando/engine/operations/restart";
export * from "@lando/engine/operations/share";
export * from "@lando/engine/operations/start";
export * from "@lando/engine/operations/stop";
export * from "@lando/engine/operations/tooling";
export * from "@lando/engine/operations/update";
export * from "./commands/agent-skills";
export * from "./commands/app-cache-refresh";
export * from "./commands/app-config";
export * from "./commands/app-config-explain";
export * from "./commands/app-config-lint";
export * from "./commands/app-config-migrate";
export * from "./commands/app-config-translate";
export * from "./commands/app-includes-update";
export * from "./commands/app-includes-verify";
export * from "./commands/config";
export * from "./commands/destroy";
export * from "./commands/exec";
export * from "./commands/info-render";
export * from "./commands/list";
export * from "./commands/logs";
export * from "./commands/meta/global-destroy";
export * from "./commands/meta/global-list";
export * from "./commands/meta/global-policy";
export * from "./commands/meta/global-rebuild";
export * from "./commands/meta/global-restart";
export * from "./commands/meta/global-start";
export * from "./commands/meta/global-stop";
export * from "./commands/poweroff";
export * from "./commands/rebuild";
export * from "./commands/remote";
export * from "./commands/restart";
export * from "./commands/scratch";
export * from "./commands/share";
export * from "./commands/shell";
export * from "./commands/start-result";
export * from "./commands/stop";
export * from "./commands/tooling";
export * from "./commands/version";
