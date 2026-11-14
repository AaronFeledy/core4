import { cliRuntimeOptions } from "@lando/engine/runtime/cli-options";

import { EventService, Renderer } from "@lando/sdk/services";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect } from "effect";
import { makeInteractionPrompter } from "../interaction/prompter";
import { retainedRecipeSourceStore } from "../recipes/runtime-sources";
import type { CliInvocationContext } from "../runtime/invocation-context";
import { makeLandoRuntime } from "../runtime/layer";
import type { BuiltInCommandEntry } from "./built-in-command-registry";
import { runSetup } from "./cli-adapters/app-lifecycle";
import { runMetaShellenv, runMetaUninstall } from "./cli-adapters/meta-plugin";
import { initOptionsFromInput } from "./command-specs/apps/init";
import { renderAgentSkillsResult } from "./commands/agent-skills";
import { initApp } from "./commands/init";
import { makeInitOutput } from "./commands/init-output.ts";
import { initUsesMachineOutput, makeInitReview, renderInitReviewNext } from "./commands/init-review.ts";
import { compiledCommandInputFromArgv } from "./compiled-input";
import { activeResultFormat, runCompiledCommand, runWithProcessAbortSignal } from "./compiled-runtime";
import type { CommandTokens } from "./invocation";

export const runNativeOnlyBuiltIn = async (
  entry: BuiltInCommandEntry,
  tokens: CommandTokens,
  parentSignal?: AbortSignal,
  context?: CliInvocationContext,
): Promise<void> => {
  if (parentSignal?.aborted) return;
  const signalOptions = parentSignal === undefined ? {} : { signal: parentSignal };
  switch (entry.spec.id) {
    case "apps:init": {
      const input = compiledCommandInputFromArgv(entry.spec.id, tokens.argv, {
        tokens,
        ...(context === undefined ? {} : { context }),
      });
      let reviewed = false;
      await runWithProcessAbortSignal(
        (signal) =>
          runCompiledCommand(
            Effect.gen(function* () {
              const events = yield* EventService;
              const privateFileAccess = yield* PrivateFileAccessService;
              const postInitIO = yield* makeInitOutput(activeResultFormat);
              const options = initOptionsFromInput(input, context);
              const renderer = yield* Renderer;
              const nonInteractive =
                options.nonInteractive === true || initUsesMachineOutput(activeResultFormat, renderer.id);
              const interaction = yield* makeInteractionPrompter(signal);
              const onPrepared = yield* makeInitReview({
                format: activeResultFormat,
                yes: options.yes === true,
                nonInteractive,
                ...(context?.io.terminalColumns === undefined ? {} : { columns: context.io.terminalColumns }),
              });
              const { store: recipeSourceStore, registryClient } = yield* retainedRecipeSourceStore(
                options.registryUrl,
              );
              return yield* initApp({
                recipeSourceStore,
                registryClient,
                ...options,
                nonInteractive,
                interaction,
                ...(onPrepared === undefined
                  ? {}
                  : {
                      onPrepared: async (review, context) => {
                        await onPrepared(review, context);
                        reviewed = true;
                      },
                    }),
                signal,
                onWarn: postInitIO.err,
                postInitIO,
                events,
                privateFileAccess,
              });
            }),
            makeLandoRuntime(
              cliRuntimeOptions({ bootstrap: "minimal", plugins: { policy: "discovery" } }, context?.env),
            ),
            (result) => {
              const created = reviewed
                ? renderInitReviewNext(result.directory)
                : `Created ${result.appName} at ${result.directory}`;
              return result.agentSkills === undefined
                ? created
                : `${created}\n${renderAgentSkillsResult(result.agentSkills)}`;
            },
            { signal, ...(context === undefined ? {} : { context }) },
          ),
        signalOptions,
      );
      return;
    }
    case "meta:setup":
      await runWithProcessAbortSignal((signal) => runSetup(tokens, signal, context), signalOptions);
      return;
    case "meta:shellenv":
      await runWithProcessAbortSignal((signal) => runMetaShellenv(tokens, signal, context), signalOptions);
      return;
    case "meta:uninstall":
      await runWithProcessAbortSignal((signal) => runMetaUninstall(tokens, signal, context), signalOptions);
      return;
    default:
      throw new TypeError(`Built-in command ${entry.spec.id} is not embedding-exempt.`);
  }
};
