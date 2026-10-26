import { Effect } from "effect";

import { EventService } from "@lando/sdk/services";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";

import { cliRuntimeOptions } from "@lando/engine/runtime/cli-options";
import { retainedRecipeSources } from "../recipes/runtime-sources";
import { makeLandoRuntime } from "../runtime/layer";
import type { BuiltInCommandEntry } from "./built-in-command-registry";
import { runSetup } from "./cli-adapters/app-lifecycle";
import { runMetaShellenv, runMetaUninstall } from "./cli-adapters/meta-plugin";
import { initOptionsFromInput } from "./command-specs/apps/init";
import { renderAgentSkillsResult } from "./commands/agent-skills";
import { initApp } from "./commands/init";
import { makeInitOutput } from "./commands/init-output.ts";
import { compiledCommandInputFromArgv } from "./compiled-input";
import { activeResultFormat, runCompiledCommand, runWithProcessAbortSignal } from "./compiled-runtime";

export const runNativeOnlyBuiltIn = async (
  entry: BuiltInCommandEntry,
  argv: ReadonlyArray<string>,
): Promise<void> => {
  switch (entry.spec.id) {
    case "apps:init": {
      const input = compiledCommandInputFromArgv(entry.spec.id, argv);
      await runWithProcessAbortSignal((signal) =>
        runCompiledCommand(
          Effect.gen(function* () {
            const events = yield* EventService;
            const privateFileAccess = yield* PrivateFileAccessService;
            const postInitIO = yield* makeInitOutput(activeResultFormat);
            const options = initOptionsFromInput(input);
            const sources = yield* retainedRecipeSources(options.registryUrl);
            return yield* Effect.tryPromise({
              try: () =>
                initApp({
                  ...sources,
                  ...options,
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
            const created = `Created ${result.appName} at ${result.directory}`;
            return result.agentSkills === undefined
              ? created
              : `${created}\n${renderAgentSkillsResult(result.agentSkills)}`;
          },
          { signal },
        ),
      );
      return;
    }
    case "meta:setup":
      await runWithProcessAbortSignal((signal) => runSetup(argv, signal));
      return;
    case "meta:shellenv":
      await runWithProcessAbortSignal((signal) => runMetaShellenv(argv, signal));
      return;
    case "meta:uninstall":
      await runWithProcessAbortSignal((signal) => runMetaUninstall(argv, signal));
      return;
    default:
      throw new TypeError(`Built-in command ${entry.spec.id} is not embedding-exempt.`);
  }
};
