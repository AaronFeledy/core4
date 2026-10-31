import { Effect } from "effect";

import { EventService, Renderer } from "@lando/sdk/services";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";

import { cliRuntimeOptions } from "@lando/engine/runtime/cli-options";
import { makeInteractionPrompter } from "../interaction/prompter";
import { retainedRecipeSources } from "../recipes/runtime-sources";
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

export const runNativeOnlyBuiltIn = async (
  entry: BuiltInCommandEntry,
  argv: ReadonlyArray<string>,
  parentSignal?: AbortSignal,
): Promise<void> => {
  if (parentSignal?.aborted) return;
  const signalOptions = parentSignal === undefined ? {} : { signal: parentSignal };
  switch (entry.spec.id) {
    case "apps:init": {
      const input = compiledCommandInputFromArgv(entry.spec.id, argv);
      let reviewed = false;
      await runWithProcessAbortSignal(
        (signal) =>
          runCompiledCommand(
            Effect.gen(function* () {
              const events = yield* EventService;
              const privateFileAccess = yield* PrivateFileAccessService;
              const postInitIO = yield* makeInitOutput(activeResultFormat);
              const options = initOptionsFromInput(input);
              const renderer = yield* Renderer;
              const nonInteractive =
                options.nonInteractive === true || initUsesMachineOutput(activeResultFormat, renderer.id);
              const interaction = yield* makeInteractionPrompter(signal);
              const onPrepared = yield* makeInitReview({
                format: activeResultFormat,
                yes: options.yes === true,
                nonInteractive,
                ...(process.stderr.columns === undefined ? {} : { columns: process.stderr.columns }),
              });
              const sources = yield* retainedRecipeSources(options.registryUrl);
              return yield* Effect.tryPromise({
                try: () =>
                  initApp({
                    ...sources,
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
                  }),
                catch: (error) => error,
              });
            }),
            makeLandoRuntime(cliRuntimeOptions({ bootstrap: "minimal", plugins: { policy: "discovery" } })),
            (result) => {
              const created = reviewed
                ? renderInitReviewNext(result.directory)
                : `Created ${result.appName} at ${result.directory}`;
              return result.agentSkills === undefined
                ? created
                : `${created}\n${renderAgentSkillsResult(result.agentSkills)}`;
            },
            { signal },
          ),
        signalOptions,
      );
      return;
    }
    case "meta:setup":
      await runWithProcessAbortSignal((signal) => runSetup(argv, signal), signalOptions);
      return;
    case "meta:shellenv":
      await runWithProcessAbortSignal((signal) => runMetaShellenv(argv, signal), signalOptions);
      return;
    case "meta:uninstall":
      await runWithProcessAbortSignal((signal) => runMetaUninstall(argv, signal), signalOptions);
      return;
    default:
      throw new TypeError(`Built-in command ${entry.spec.id} is not embedding-exempt.`);
  }
};
