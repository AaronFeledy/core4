import { Effect, Layer } from "effect";

import { cliRuntimeOptions } from "@lando/engine/runtime/cli-options";
import type { ConfigError, LandoRuntimeBootstrapError } from "@lando/sdk/errors";
import { makeLandoRuntime } from "../runtime/layer";
import type { BuiltInCommandEntry } from "./built-in-command-registry";
import { runMetaMcp } from "./cli-adapters/meta-plugin";
import { compiledCommandInputFromArgv } from "./compiled-input";
import { InvalidCliInvocationError, invocationParityError } from "./compiled-invocation-parity";
import { runCompiledCommand, runWithProcessAbortSignal } from "./compiled-runtime";
import type { LandoCommandSpec } from "./spec/command-base";

export const compiledCommandOptionsFromSpec = (spec: LandoCommandSpec, input: unknown) => {
  const streamingMode =
    typeof spec.streamingMode === "function" ? spec.streamingMode(input) : spec.streamingMode;
  return {
    ...(streamingMode === undefined ? {} : { streamingMode }),
    suppressDeprecationDiagnostics: spec.suppressDeprecationDiagnostics?.(input) === true,
    ...(spec.successExitCode === undefined
      ? {}
      : { successExitCode: (result: unknown) => spec.successExitCode?.(result, input) }),
  };
};

export const runBuiltInCommand = (entry: BuiltInCommandEntry, argv: ReadonlyArray<string>): Promise<void> => {
  const diagnostic = entry.spec.strict === false ? undefined : invocationParityError(entry.spec.id, argv);
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
    if (entry.spec.id === "meta:mcp") return runMetaMcp(argv);

    const runtime = makeLandoRuntime(
      cliRuntimeOptions({ bootstrap: entry.spec.bootstrap, plugins: { policy: "discovery" } }),
    ) as Layer.Layer<unknown, ConfigError | LandoRuntimeBootstrapError>;
    return runCompiledCommand(
      entry.spec.run(input),
      runtime,
      (result, context) => entry.spec.render?.(result, input, context),
      compiledCommandOptionsFromSpec(entry.spec, input),
    );
  });
};
