import { Effect } from "effect";

import type { ToolingResult } from "@lando/sdk/app";
import type { ShellExecError, ShellScriptOutsideRootError } from "@lando/sdk/errors";
import { NotImplementedError, ToolingExecError } from "@lando/sdk/errors";
import { EventService } from "@lando/sdk/services";

import { type DiscoveredBunShellScript, discoverBunShellScripts } from "@lando/landofile/bun-sh-discovery";
import { runHostScript } from "../services/host-tooling-engine.ts";
import { commandAliasConflictError, reservedTopLevelAliasOwner } from "./reserved-aliases.ts";
import { emitToolingOutputProgress } from "./tooling-progress.ts";

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

export const runBunShellTooling = (
  options: {
    readonly name: string;
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly renderProgress?: boolean;
  },
  appRoot: string,
) =>
  Effect.gen(function* () {
    const scripts = yield* discoverBunShellScripts({ appRoot });
    const script = findBunShellScriptForName(scripts, options.name);
    if (script === undefined) return undefined;

    const toolingLookupKey = options.name.startsWith("app:") ? options.name.slice(4) : options.name;
    const reservedOwner = reservedTopLevelAliasOwner(toolingLookupKey);
    if (reservedOwner !== undefined) {
      return yield* Effect.fail(
        commandAliasConflictError(toolingLookupKey, `script-backed tooling task ${script.id}`),
      );
    }

    const events = options.renderProgress === true ? yield* Effect.serviceOption(EventService) : undefined;
    const progressEvents = events?._tag === "Some" ? events.value : undefined;
    const startedAt = Date.now();
    const result = yield* runBunShellScript(script, appRoot, options);
    yield* emitToolingOutputProgress({
      events: progressEvents,
      tool: result.tool,
      service: result.service,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - startedAt,
    });
    return {
      ...result,
      ...(progressEvents === undefined ? {} : { rendered: true }),
    } satisfies ToolingResult;
  });
