import { Effect } from "effect";

import type { ToolingResult } from "@lando/sdk/app";
import type { ShellExecError, ShellScriptOutsideRootError } from "@lando/sdk/errors";
import { NotImplementedError, ToolingExecError } from "@lando/sdk/errors";

import type { DiscoveredBunShellScript } from "../../landofile/bun-sh-discovery.ts";
import { runHostScript } from "../../services/host-tooling-engine.ts";

const HOST_SERVICE = ":host";

export const findBunShellScriptForName = (
  scripts: ReadonlyArray<DiscoveredBunShellScript>,
  name: string,
): DiscoveredBunShellScript | undefined => {
  const target = name.startsWith("app:") ? name : `app:${name}`;
  return scripts.find((script) => script.id === target);
};

export const runBunShellScript = (
  script: DiscoveredBunShellScript,
  appRoot: string,
  options: {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
  },
): Effect.Effect<
  ToolingResult,
  NotImplementedError | ShellExecError | ShellScriptOutsideRootError | ToolingExecError
> =>
  Effect.gen(function* () {
    if (script.service !== HOST_SERVICE) {
      return yield* Effect.fail(
        new NotImplementedError({
          message: `.bun.sh script "${script.id}" declares service "${script.service}"; service-targeted .bun.sh scripts are deferred to Beta.`,
          commandId: "tooling.run",
          remediation:
            "Remove the `service:` field (or set it to `:host`) so the script runs through the host engine, or move the body into a Landofile tooling task that targets the desired service.",
        }),
      );
    }
    const cwd = options.cwd ?? appRoot;
    const env = options.env;
    const result = yield* runHostScript(script.path, [appRoot], {
      cwd,
      ...(env === undefined ? {} : { env }),
    }).pipe(
      Effect.catchTag("ShellExecError", (shellError) =>
        Effect.fail(
          new ToolingExecError({
            message: `Script-backed tooling task ${script.id} failed: ${shellError.message}`,
            tool: script.id,
            ...(shellError.exitCode === undefined ? {} : { exitCode: shellError.exitCode }),
            remediation: `Inspect the tooling task ${script.id} output, fix the script, and rerun the command.`,
            cause: shellError,
          }),
        ),
      ),
    );
    return {
      tool: script.id,
      service: HOST_SERVICE,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    } satisfies ToolingResult;
  });
