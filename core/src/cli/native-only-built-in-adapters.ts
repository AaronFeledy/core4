import { Effect } from "effect";

import { cliRuntimeOptions } from "@lando/engine/runtime/cli-options";
import { makeLandoRuntime } from "../runtime/layer";
import type { BuiltInCommandEntry } from "./built-in-command-registry";
import { runSetup } from "./cli-adapters/app-lifecycle";
import { runMetaShellenv, runMetaUninstall } from "./cli-adapters/meta-plugin";
import { initOptionsFromInput } from "./command-specs/apps/init";
import { initApp } from "./commands/init";
import { compiledCommandInputFromArgv } from "./compiled-input";
import { emitDiagnosticLine, runCompiledCommand } from "./compiled-runtime";

export const runNativeOnlyBuiltIn = async (
  entry: BuiltInCommandEntry,
  argv: ReadonlyArray<string>,
): Promise<void> => {
  switch (entry.spec.id) {
    case "apps:init": {
      const input = compiledCommandInputFromArgv(entry.spec.id, argv);
      await runCompiledCommand(
        Effect.tryPromise({
          try: () => initApp({ ...initOptionsFromInput(input), onWarn: emitDiagnosticLine }),
          catch: (error) => error,
        }),
        makeLandoRuntime(cliRuntimeOptions({ bootstrap: "minimal", plugins: { policy: "discovery" } })),
        (result) => `Created ${result.appName} at ${result.directory}`,
      );
      return;
    }
    case "meta:setup":
      await runSetup(argv);
      return;
    case "meta:shellenv":
      await runMetaShellenv(argv);
      return;
    case "meta:uninstall":
      await runMetaUninstall(argv);
      return;
    default:
      throw new TypeError(`Built-in command ${entry.spec.id} is not embedding-exempt.`);
  }
};
