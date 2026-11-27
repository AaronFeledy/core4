import { cliRuntimeOptions } from "@lando/engine/runtime/cli-options";
import type { ConfigError, LandoRuntimeBootstrapError } from "@lando/sdk/errors";
import { Effect, Layer, Result } from "effect";
import type { CliInvocationContext } from "../runtime/invocation-context";
import { makeLandoRuntime } from "../runtime/layer";
import type { BuiltInCommandEntry } from "./built-in-command-registry";
import { runMetaMcp } from "./cli-adapters/meta-plugin";
import { commandStructureExample } from "./compiled-argv";
import { compiledCommandInputFromArgv } from "./compiled-input";
import { InvalidCliInvocationError, invocationParityError } from "./compiled-invocation-parity";
import { runCompiledCommand, runWithProcessAbortSignal } from "./compiled-runtime";
import { type HostProxyLandoCall, withHostProxyCall } from "./host-proxy/call-context";
import type { CommandTokens } from "./invocation";
import type { LandoCommandSpec } from "./spec/command-base";

export const compiledCommandOptionsFromSpec = (spec: LandoCommandSpec, input: unknown) => {
  const completion = spec.completion;
  const streamingMode =
    typeof spec.streamingMode === "function" ? spec.streamingMode(input) : spec.streamingMode;
  return {
    ...(streamingMode === undefined ? {} : { streamingMode }),
    suppressDeprecationDiagnostics: spec.suppressDeprecationDiagnostics?.(input) === true,
    ...(completion === undefined ? {} : { completion: (result: unknown) => completion(result, input) }),
  };
};

export const runBuiltInCommand = (
  entry: BuiltInCommandEntry,
  tokens: CommandTokens,
  parentSignal?: AbortSignal,
  hostProxy?: HostProxyLandoCall,
  context?: CliInvocationContext,
): Promise<void> => {
  if (parentSignal?.aborted) return Promise.resolve();
  const diagnostic =
    entry.spec.strict === false ? undefined : invocationParityError(entry.spec.id, tokens.argv);
  if (diagnostic !== undefined) {
    return runCompiledCommand(
      Effect.fail(
        new InvalidCliInvocationError({
          message: diagnostic,
          commandId: entry.spec.id,
          remediation: `Example: ${commandStructureExample(entry.spec.id) ?? `lando ${entry.spec.id}`}`,
        }),
      ),
      Layer.empty,
      () => undefined,
      {
        preCommand: true,
        usage: true,
        ...(context === undefined ? {} : { context }),
      },
    );
  }

  return runWithProcessAbortSignal(
    async (signal) => {
      const input = compiledCommandInputFromArgv(entry.spec.id, tokens.argv, {
        tokens,
        signal,
        ...(context === undefined ? {} : { context }),
      });
      const inputError = entry.spec.validateInput?.(input);
      if (inputError !== undefined) {
        return runCompiledCommand(Effect.fail(inputError), Layer.empty, () => undefined, {
          preCommand: true,
          usage: true,
          signal,
          ...(context === undefined ? {} : { context }),
        });
      }
      if (entry.spec.id === "meta:mcp") return runMetaMcp(tokens, signal, context);

      const nativeScratch =
        entry.spec.id === "apps:scratch:start" && hostProxy === undefined && "source" in input.flags
          ? (await import("./native-scratch-start")).prepareNativeScratchStart(
              input,
              context?.cwd ?? process.cwd(),
            )
          : undefined;
      if (nativeScratch !== undefined && Result.isFailure(nativeScratch)) {
        return runCompiledCommand(Effect.fail(nativeScratch.failure), Layer.empty, () => undefined, {
          ...(context === undefined ? {} : { context }),
          signal,
        });
      }
      const runtime = makeLandoRuntime(
        cliRuntimeOptions(
          {
            bootstrap: entry.spec.bootstrap,
            plugins: {
              policy: "discovery",
              ...(nativeScratch === undefined ? {} : { layers: nativeScratch.success.layers }),
            },
          },
          context?.env,
        ),
      ) as Layer.Layer<unknown, ConfigError | LandoRuntimeBootstrapError>;
      return runCompiledCommand(
        hostProxy === undefined
          ? (nativeScratch?.success.operation ?? entry.spec.run(input))
          : withHostProxyCall(entry.spec.run(input), hostProxy, entry.spec.id),
        runtime,
        // Hooks only receive the value produced by this same spec's run.
        (result, context) => entry.spec.render?.(result, input, context),
        {
          ...compiledCommandOptionsFromSpec(entry.spec, input),
          signal,
          ...(context === undefined ? {} : { context }),
        },
      );
    },
    parentSignal === undefined ? {} : { signal: parentSignal },
  );
};
