import type { BufferedRendererIO } from "@lando/renderer/io";
import { layerPlainService } from "@lando/renderer/runtime";
import type { Redactor } from "@lando/sdk/secrets";
import { type Cause, Effect } from "effect";
import type { RunWithRendererHandlingOptions } from "../../src/cli/renderer-boundary";
import { makeTerminalCommitter } from "../../src/cli/terminal-document";
import { planTerminalFailure, recordCliDefect } from "../../src/cli/terminal-failure";

/** Plans the boundary's fallback failure document and commits it the way the boundary does. */
export const commitTerminalFailure = <A, R, RE>(
  cause: Cause.Cause<unknown>,
  options: RunWithRendererHandlingOptions<A, R, RE> & { readonly io: BufferedRendererIO },
  redactor: Redactor,
): Promise<void> => {
  const committer = makeTerminalCommitter({
    signal: options.signal,
    setExitCode: options.setExitCode,
    brokenPipe: () => false,
    recordDefect: (defect) => recordCliDefect(defect, redactor, options.io),
  });
  return Effect.runPromise(
    planTerminalFailure(cause, options, redactor).pipe(
      Effect.flatMap(committer.commit),
      Effect.provide(layerPlainService(options.io)),
    ),
  );
};
