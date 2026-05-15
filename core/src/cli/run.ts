/**
 * CLI runner — invoked from `bin/lando.ts`.
 *
 * This is the *only* place where `@oclif/core`'s top-level `execute`/`run`
 * runs. It is the imperative shell that:
 *   1. Wires OCLIF hooks (init, prerun, postrun, command_not_found).
 *   2. Installs SIGINT/SIGTERM handlers that bridge to `Effect.interrupt`.
 *   3. Hands argv to OCLIF for parsing.
 *   4. OCLIF resolves the command; the command's `run()` calls into Effect
 *      via `LandoCommandBase.runEffect`.
 *
 * Status: stub.
 */
import { fileURLToPath } from "node:url";

import { execute } from "@oclif/core";
import type { Command } from "@oclif/core";
import { Cause, Effect, Exit } from "effect";

import { InitTargetExistsError } from "@lando/sdk/errors";

import { makeLandoRuntime } from "../runtime/layer.ts";
import { infoApp, renderInfoAppResult } from "./commands/info.ts";
import { initApp } from "./commands/init.ts";
import { renderStartAppResult, startApp } from "./commands/start.ts";
import { renderStopAppResult, stopApp } from "./commands/stop.ts";
import { notImplementedErrorForCommand } from "./oclif/command-base.ts";
import compiledCommands from "./oclif/compiled-commands.ts";

const version = "@lando/core/0.0.0";

type CompiledCommand = Command.Class;

const commandEntries: Array<[string, CompiledCommand]> = Object.entries(compiledCommands).sort(
  ([left], [right]) => left.localeCompare(right),
);

const commandName = (id: string, command: CompiledCommand): string => {
  const aliases = command.aliases;
  if (!aliases || aliases.length === 0) return id;
  const nonFlagAlias = aliases.find((alias) => !alias.startsWith("-"));
  if (nonFlagAlias !== undefined) return nonFlagAlias;
  return aliases[0] ?? id;
};

const findCommand = (name: string): [string, CompiledCommand] | undefined =>
  commandEntries.find(([id, command]) => id === name || command.aliases?.includes(name));

const printRootHelp = (): void => {
  console.log(`Lando v4 core: runtime, planner, OCLIF adapter, and library API.

VERSION
  ${version} ${process.platform}-${process.arch} node-${process.version}

USAGE
  $ lando [COMMAND]

TOPICS
  app   Operate on the current Lando app.
  apps  Discover and operate across Lando apps on the host.
  meta  Operate on Lando itself: config, plugins, host setup.

COMMANDS`);
  for (const [id, command] of commandEntries) {
    const name = commandName(id, command);
    if (!name.includes(":")) {
      console.log(`  ${name.padEnd(22)} ${command.description ?? ""}`);
    }
  }
};

const printCommandHelp = (id: string, command: CompiledCommand): void => {
  console.log(`${command.description ?? command.summary ?? id}

USAGE
  $ lando ${commandName(id, command)}

ALIASES
  ${[id, ...(command.aliases ?? [])].join(", ")}`);
};

const commandErrorMessage = (error: unknown): string => {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    const details: string[] = [error.message];
    const tag = "_tag" in error && typeof error._tag === "string" ? error._tag : undefined;
    if (tag === "LandofileParseError" && "filePath" in error && typeof error.filePath === "string")
      details.push(`filePath: ${error.filePath}`);
    if (tag === "LandofileParseError" && "line" in error && typeof error.line === "number")
      details.push(`line: ${error.line}`);
    if (tag === "NotImplementedError") details.unshift(tag);
    if (tag === "NotImplementedError" && "commandId" in error && typeof error.commandId === "string")
      details.push(`commandId: ${error.commandId}`);
    if (tag === "NotImplementedError" && "specSection" in error && typeof error.specSection === "string")
      details.push(`specSection: ${error.specSection}`);
    if ("remediation" in error && typeof error.remediation === "string") details.push(error.remediation);
    if (tag === "LandofileNotFoundError")
      details.push("Run `lando init --full --name=<name>` to scaffold an app.");
    return details.join("\n");
  }
  return String(error);
};

const runStart = async (): Promise<void> => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const exit = await Effect.runPromiseExit(
      startApp({ signal: controller.signal }).pipe(Effect.provide(makeLandoRuntime({ bootstrap: "app" }))),
    );
    if (Exit.isSuccess(exit)) {
      console.log(renderStartAppResult(exit.value));
      return;
    }
    const failure = Cause.failureOption(exit.cause);
    console.error(failure._tag === "Some" ? commandErrorMessage(failure.value) : Cause.pretty(exit.cause));
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
};

const runStop = async (): Promise<void> => {
  const exit = await Effect.runPromiseExit(
    stopApp().pipe(Effect.provide(makeLandoRuntime({ bootstrap: "app" }))),
  );
  if (Exit.isSuccess(exit)) {
    console.log(renderStopAppResult(exit.value));
    return;
  }
  const failure = Cause.failureOption(exit.cause);
  console.error(failure._tag === "Some" ? commandErrorMessage(failure.value) : Cause.pretty(exit.cause));
  process.exitCode = 1;
};

const runInfo = async (): Promise<void> => {
  const exit = await Effect.runPromiseExit(
    infoApp().pipe(Effect.provide(makeLandoRuntime({ bootstrap: "app" }))),
  );
  if (Exit.isSuccess(exit)) {
    console.log(renderInfoAppResult(exit.value));
    return;
  }
  const failure = Cause.failureOption(exit.cause);
  console.error(failure._tag === "Some" ? commandErrorMessage(failure.value) : Cause.pretty(exit.cause));
  process.exitCode = 1;
};

const runCompiledCli = async (argv: ReadonlyArray<string>): Promise<void> => {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    const commandArg = argv.find((arg) => !arg.startsWith("-"));
    if (commandArg === undefined) {
      printRootHelp();
      return;
    }

    const found = findCommand(commandArg);
    if (found === undefined) {
      throw new Error(`Command ${commandArg} not found`);
    }

    printCommandHelp(found[0], found[1]);
    return;
  }

  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(`${version} ${process.platform}-${process.arch} node-${process.version}`);
    return;
  }

  if (argv[0] === "init" || argv[0] === "apps:init") {
    const nameFlag = argv.find((arg) => arg.startsWith("--name="));
    const name = nameFlag?.slice("--name=".length);
    const full = argv.includes("--full");
    try {
      const result =
        name === undefined
          ? await initApp({ cwd: process.cwd(), full })
          : await initApp({ cwd: process.cwd(), full, name });
      console.log(`Created ${result.appName} at ${result.directory}`);
    } catch (error) {
      const message =
        error instanceof InitTargetExistsError
          ? `${error.message}\n${error.remediation}`
          : error instanceof Error
            ? error.message
            : String(error);
      console.error(message);
      process.exitCode = 1;
    }
    return;
  }

  if (argv[0] === "start" || argv[0] === "app:start") {
    await runStart();
    return;
  }

  if (argv[0] === "stop" || argv[0] === "app:stop") {
    await runStop();
    return;
  }

  if (argv[0] === "info" || argv[0] === "app:info") {
    await runInfo();
    return;
  }

  const found = findCommand(argv[0] ?? "");
  if (found === undefined) {
    throw new Error(`Command ${argv[0] ?? ""} not found`);
  }

  console.error(commandErrorMessage(notImplementedErrorForCommand(found[0])));
  process.exitCode = 1;
};

export interface RunCliOptions {
  /** argv (without `process.argv[0..1]`). */
  readonly argv: ReadonlyArray<string>;
  /** `import.meta.url` from the binary entry point. */
  readonly rootUrl: string;
}

/**
 * Run the Lando CLI.
 *
 * TODO: wire up:
 *   - the OCLIF hooks from `./oclif/hooks/`
 *   - SIGINT/SIGTERM → Effect.interrupt
 *   - exit-code translation from tagged errors
 */
export const runCli = async (options: RunCliOptions): Promise<void> => {
  const entryPath = fileURLToPath(options.rootUrl);
  const args = options.argv as Array<string>;

  if (entryPath.includes("$bunfs")) {
    await runCompiledCli(options.argv);
    return;
  }

  // For now, hand straight to OCLIF. Hooks land via the `oclif` config in
  // `package.json` once they're wired into the manifest pipeline.
  await execute({
    dir: options.rootUrl,
    args,
  });
};
