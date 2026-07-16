/**
 * OCLIF `init` hook — Lando bootstrap.
 *
 * The init hook runs after OCLIF has resolved the command id and before the
 * command class is instantiated. It loads the resolved command class, reads
 * its declared bootstrap level, builds the matching Lando runtime Layer, and
 * stores that Layer for `LandoCommandBase.runEffect()` to provide to the
 * command's Effect program.
 */
import type { Command, Hook } from "@oclif/core";
import { Either, Schema } from "effect";

import { LandoRuntimeBootstrapError } from "@lando/sdk/errors";
import { BootstrapLevel, type BootstrapLevel as BootstrapLevelType } from "@lando/sdk/schema";

import { cliRuntimeOptions } from "../../../runtime/cli-options.ts";
import { makeLandoRuntime } from "../../../runtime/layer.ts";
import { preCommandOutputMode, renderPreCommandFailure } from "../../oclif/command-boundary.ts";

type LandoCommandClass = Command.Class & {
  readonly bootstrap?: unknown;
};

type LandoRuntimeLayer = ReturnType<typeof makeLandoRuntime>;

const commandRuntimeLayers = new WeakMap<Command.Class, LandoRuntimeLayer>();

const bootstrapError = (message: string, cause?: unknown): LandoRuntimeBootstrapError =>
  new LandoRuntimeBootstrapError({
    message,
    stage: "minimal",
    cause,
  });

const readBootstrapLevel = (CommandClass: LandoCommandClass): BootstrapLevelType => {
  const decoded = Schema.decodeUnknownEither(BootstrapLevel)(CommandClass.bootstrap);

  if (Either.isLeft(decoded)) {
    throw bootstrapError("OCLIF command is missing a valid static bootstrap declaration.", decoded.left);
  }

  return decoded.right;
};

export const getCommandRuntimeLayer = (CommandClass: Command.Class): LandoRuntimeLayer | undefined =>
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
    makeLandoRuntime(cliRuntimeOptions({ bootstrap, plugins: { policy: "discovery" } })),
  );
};
