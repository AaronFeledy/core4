/**
 * Renderer-optional passthrough writers for operation modules.
 *
 * Operations that stream provider output (`exec`) hand raw chunks to whatever
 * `Renderer` the caller installed and stay silent when none is present, so the
 * same operation works under the CLI, the library API, and test layers. Only
 * the sdk-published `Renderer` tag is used — never a renderer implementation.
 */
import { Effect, Option } from "effect";

import { Renderer } from "@lando/sdk/services";

const optionalRenderer = Effect.serviceOption(Renderer);

export const emitOptionalStdout = (chunk: string): Effect.Effect<void> =>
  optionalRenderer.pipe(
    Effect.flatMap((option) => (Option.isSome(option) ? option.value.output.stdout(chunk) : Effect.void)),
  );

export const emitOptionalStderr = (chunk: string): Effect.Effect<void> =>
  optionalRenderer.pipe(
    Effect.flatMap((option) => (Option.isSome(option) ? option.value.output.stderr(chunk) : Effect.void)),
  );
