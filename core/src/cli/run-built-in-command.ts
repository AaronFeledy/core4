import { Effect, Layer } from "effect";

import { cliRuntimeOptions } from "@lando/engine/runtime/cli-options";
import type { ConfigError, LandoRuntimeBootstrapError } from "@lando/sdk/errors";
import { makeLandoRuntime } from "../runtime/layer";
import type { BuiltInCommandEntry } from "./built-in-command-registry";
import { runMetaMcp } from "./cli-adapters/meta-plugin";
import { compiledCommandInputFromArgv } from "./compiled-input";
import { InvalidCliInvocationError, invocationParityError } from "./compiled-invocation-parity";
import { runCompiledCommand, runWithProcessAbortSignal } from "./compiled-runtime";

export const runBuiltInCommand = (entry: BuiltInCommandEntry, argv: ReadonlyArray<string>): Promise<void> => {
  const diagnostic = invocationParityError(entry.spec.id, argv);
  if (diagnostic !== undefined) {
    return runCompiledCommand(
      Effect.fail(
        new InvalidCliInvocationError({
          message: diagnostic,
          commandId: entry.spec.id,
          remediation: `Fix the invocation or run \`lando ${entry.spec.id} --help\` for usage.`,
        }),
      ),
      Layer.empty,
      () => undefined,
      { failureExitCode: () => 2, preCommand: true },
    );
  }

  return runWithProcessAbortSignal((signal) => {
    const input = compiledCommandInputFromArgv(entry.spec.id, argv, { signal });
    if (entry.spec.id === "meta:mcp" && input.flags.list !== true) return runMetaMcp(argv);

    const streamingMode =
      typeof entry.spec.streamingMode === "function"
        ? entry.spec.streamingMode(input)
        : entry.spec.streamingMode;
    const runtime = makeLandoRuntime(
      cliRuntimeOptions({ bootstrap: entry.spec.bootstrap, plugins: { policy: "discovery" } }),
    ) as Layer.Layer<unknown, ConfigError | LandoRuntimeBootstrapError>;
    return runCompiledCommand(
      entry.spec.run(input),
      runtime,
      (result, context) => entry.spec.render?.(result, input, context),
      {
        ...(streamingMode === undefined ? {} : { streamingMode }),
        suppressDeprecationDiagnostics: entry.spec.suppressDeprecationDiagnostics?.(input) === true,
        ...(entry.spec.successExitCode === undefined
          ? {}
          : { successExitCode: (result) => entry.spec.successExitCode?.(result, input) }),
      },
    );
  });
};
