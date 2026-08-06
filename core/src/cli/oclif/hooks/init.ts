/**
 * Legacy-compatible init adapter — Lando bootstrap.
 *
 * The init adapter runs after command metadata resolves the command id and
 * before the command class is instantiated. It loads the resolved class, reads
 * its declared bootstrap level, builds the matching Lando runtime Layer, and
 * stores that Layer for `LandoCommandBase.runEffect()` to provide to the
 * command's Effect program.
 */
import { Either, Schema } from "effect";

import { LandoRuntimeBootstrapError } from "@lando/sdk/errors";
import { BootstrapLevel, type BootstrapLevel as BootstrapLevelType } from "@lando/sdk/schema";

import { cliRuntimeOptions, resolveEffectiveCliBootstrap } from "../../../runtime/cli-options.ts";
import { makeLandoRuntime } from "../../../runtime/layer.ts";
import { preCommandOutputMode, renderPreCommandFailure } from "../../oclif/command-boundary.ts";
import type { CommandClass, Hook } from "../metadata.ts";

type LandoCommandClass = CommandClass & {
  readonly bootstrap?: unknown;
};

type LandoRuntimeLayer = ReturnType<typeof makeLandoRuntime>;

const commandRuntimeLayers = new WeakMap<CommandClass, LandoRuntimeLayer>();

const bootstrapError = (message: string, cause?: unknown): LandoRuntimeBootstrapError =>
  new LandoRuntimeBootstrapError({
    message,
    stage: "minimal",
    cause,
  });

const readBootstrapLevel = (CommandClass: LandoCommandClass): BootstrapLevelType => {
  const decoded = Schema.decodeUnknownEither(BootstrapLevel)(CommandClass.bootstrap);

  if (Either.isLeft(decoded)) {
    throw bootstrapError("Command is missing a valid static bootstrap declaration.", decoded.left);
  }

  return decoded.right;
};

export const getCommandRuntimeLayer = (CommandClass: CommandClass): LandoRuntimeLayer | undefined =>
  commandRuntimeLayers.get(CommandClass);

export const initHook: Hook<"init"> = async ({ argv, config, context, id }) => {
  if (id === undefined) return;

  const command = config.findCommand(id);
  if (command === undefined) return;

  const CommandClass = (await command.load()) as LandoCommandClass;
  let bootstrap: BootstrapLevelType;
  try {
    bootstrap = readBootstrapLevel(CommandClass);
  } catch (error) {
    if (error instanceof LandoRuntimeBootstrapError) {
      await renderPreCommandFailure({
        commandId: id,
        error,
        ...preCommandOutputMode({ argv, env: process.env }),
      });
      context.exit(1);
      return;
    }
    throw error;
  }
  commandRuntimeLayers.set(
    CommandClass,
    makeLandoRuntime(
      cliRuntimeOptions({
        bootstrap: resolveEffectiveCliBootstrap(id, bootstrap),
        plugins: { policy: "discovery" },
      }),
    ),
  );
};
