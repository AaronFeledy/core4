import { HostExecutionDefaults } from "@lando/engine/services/host-execution-context";
import { RendererHost, type RendererIO, isStdioRendererIO } from "@lando/renderer/io";
import { DeprecationRecorder, makeDeprecationRecorder } from "@lando/sdk/services";
import { LockHolder } from "@lando/state-store/lock-holder";
import { Effect } from "effect";
import { CliInvocation, type CliInvocationContext } from "../runtime/invocation-context";
import { COMMAND_REGISTRY_MANIFEST } from "./generated/command-registry-manifest";

const commandAliases: Readonly<Record<string, { readonly aliases: ReadonlyArray<string> }>> =
  COMMAND_REGISTRY_MANIFEST.commands;

/** How a user types the command (`lando start` for `app:start`), recorded on locks it holds. */
const holderCommandLabel = (commandId: string): string =>
  `lando ${commandAliases[commandId]?.aliases[0] ?? commandId}`;

/**
 * Provides the invocation's host context, lock-holder label, and a fresh
 * deprecation recorder, so the run's deprecation uses are its own.
 */
export const withInvocationServices = <A, E, R>(
  program: Effect.Effect<A, E, R>,
  invocation: {
    readonly command: string | undefined;
    readonly context: CliInvocationContext | undefined;
    readonly realIO: RendererIO;
    readonly sourceEnv: Readonly<Record<string, string | undefined>>;
  },
) => {
  const { command, context, realIO, sourceEnv } = invocation;
  const withHost =
    context === undefined
      ? program
      : program.pipe(
          Effect.provideService(CliInvocation, context),
          Effect.provideService(HostExecutionDefaults, {
            cwd: context.cwd,
            env: context.env,
            platform: process.platform,
            ...(!isStdioRendererIO(realIO) && realIO.stdin !== undefined ? { stdin: realIO.stdin } : {}),
          }),
        );
  return withHost.pipe(
    Effect.provideService(RendererHost, { io: realIO, env: sourceEnv }),
    Effect.provideService(LockHolder, command === undefined ? {} : { command: holderCommandLabel(command) }),
    Effect.provideService(DeprecationRecorder, makeDeprecationRecorder().recorder),
  );
};
