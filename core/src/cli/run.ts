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

const runCompiledCli = (argv: ReadonlyArray<string>): void => {
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

  const found = findCommand(argv[0] ?? "");
  if (found === undefined) {
    throw new Error(`Command ${argv[0] ?? ""} not found`);
  }

  throw new Error(`${found[0]}: not yet implemented`);
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
    runCompiledCli(options.argv);
    return;
  }

  // For now, hand straight to OCLIF. Hooks land via the `oclif` config in
  // `package.json` once they're wired into the manifest pipeline.
  await execute({
    dir: options.rootUrl,
    args,
  });
};
