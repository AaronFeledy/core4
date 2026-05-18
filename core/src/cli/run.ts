import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { execute } from "@oclif/core";
import type { Command } from "@oclif/core";
import { Cause, Effect, Exit } from "effect";

import { InitTargetExistsError, NotImplementedError } from "@lando/sdk/errors";

import { makeLandoRuntime } from "../runtime/layer.ts";
import { destroyApp, renderDestroyAppResult } from "./commands/destroy.ts";
import { doctor, renderDoctorResult } from "./commands/doctor.ts";
import { execApp, renderExecAppResult } from "./commands/exec.ts";
import { infoApp, renderInfoAppResult } from "./commands/info.ts";
import { initApp } from "./commands/init.ts";
import { renderShellAppResult, shellApp } from "./commands/shell.ts";
import { renderStartAppResult, startApp } from "./commands/start.ts";
import { renderStopAppResult, stopApp } from "./commands/stop.ts";
import { notImplementedErrorForCommand } from "./oclif/command-base.ts";
import { setupSpec } from "./oclif/commands/meta/setup.ts";
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

const runDestroy = async (argv: ReadonlyArray<string>): Promise<void> => {
  const volumes = argv.includes("--volumes");
  const yes = argv.includes("--yes") || argv.includes("-y");
  const exit = await Effect.runPromiseExit(
    destroyApp({ volumes, yes }).pipe(Effect.provide(makeLandoRuntime({ bootstrap: "app" }))),
  );
  if (Exit.isSuccess(exit)) {
    console.log(renderDestroyAppResult(exit.value));
    return;
  }
  const failure = Cause.failureOption(exit.cause);
  console.error(failure._tag === "Some" ? commandErrorMessage(failure.value) : Cause.pretty(exit.cause));
  process.exitCode = 1;
};

const runSetup = async (): Promise<void> => {
  const installDir = dirname(process.execPath);
  const exit = await Effect.runPromiseExit(
    setupSpec.run({ installDir }).pipe(Effect.provide(makeLandoRuntime({ bootstrap: "provider" }))),
  );
  if (Exit.isSuccess(exit)) {
    const rendered = setupSpec.render?.(exit.value);
    if (rendered !== undefined) console.log(rendered);
    return;
  }
  const failure = Cause.failureOption(exit.cause);
  const message = failure._tag === "Some" ? commandErrorMessage(failure.value) : Cause.pretty(exit.cause);
  console.error(`${message}\nLANDO_INSTALL_DIR="${installDir}"`);
  process.exitCode = 1;
};

const runDoctor = async (): Promise<void> => {
  const exit = await Effect.runPromiseExit(
    doctor().pipe(Effect.provide(makeLandoRuntime({ bootstrap: "provider" }))),
  );
  if (Exit.isSuccess(exit)) {
    console.log(renderDoctorResult(exit.value));
    return;
  }
  const failure = Cause.failureOption(exit.cause);
  console.error(failure._tag === "Some" ? commandErrorMessage(failure.value) : Cause.pretty(exit.cause));
  process.exitCode = 1;
};

interface ParsedExecArgv {
  readonly service?: string;
  readonly user?: string;
  readonly cwd?: string;
  readonly command: ReadonlyArray<string>;
}

const parseStringFlag = (
  argv: ReadonlyArray<string>,
  index: number,
  longName: string,
  shortName?: string,
): { readonly value: string; readonly consumed: number } | undefined => {
  const arg = argv[index];
  if (arg === undefined) return undefined;
  const longEq = `--${longName}=`;
  if (arg.startsWith(longEq)) return { value: arg.slice(longEq.length), consumed: 1 };
  if (arg === `--${longName}` || (shortName !== undefined && arg === `-${shortName}`)) {
    const next = argv[index + 1];
    if (next === undefined) return undefined;
    return { value: next, consumed: 2 };
  }
  if (shortName !== undefined) {
    const shortEq = `-${shortName}=`;
    if (arg.startsWith(shortEq)) return { value: arg.slice(shortEq.length), consumed: 1 };
  }
  return undefined;
};

const parseExecArgv = (argv: ReadonlyArray<string>): ParsedExecArgv => {
  let service: string | undefined;
  let user: string | undefined;
  let cwd: string | undefined;
  const command: string[] = [];
  let i = 0;
  let positionalStarted = false;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) {
      i += 1;
      continue;
    }
    if (!positionalStarted && arg === "--") {
      positionalStarted = true;
      i += 1;
      continue;
    }
    if (!positionalStarted && (arg.startsWith("--") || (arg.startsWith("-") && arg.length > 1))) {
      const serviceMatch = parseStringFlag(argv, i, "service", "s");
      if (serviceMatch !== undefined) {
        service = serviceMatch.value;
        i += serviceMatch.consumed;
        continue;
      }
      const userMatch = parseStringFlag(argv, i, "user", "u");
      if (userMatch !== undefined) {
        user = userMatch.value;
        i += userMatch.consumed;
        continue;
      }
      const cwdMatch = parseStringFlag(argv, i, "cwd");
      if (cwdMatch !== undefined) {
        cwd = cwdMatch.value;
        i += cwdMatch.consumed;
        continue;
      }
      positionalStarted = true;
      command.push(arg);
      i += 1;
      continue;
    }
    positionalStarted = true;
    command.push(arg);
    i += 1;
  }
  return {
    ...(service === undefined ? {} : { service }),
    ...(user === undefined ? {} : { user }),
    ...(cwd === undefined ? {} : { cwd }),
    command,
  };
};

const runExec = async (argv: ReadonlyArray<string>): Promise<void> => {
  const parsed = parseExecArgv(argv);
  const exit = await Effect.runPromiseExit(
    execApp({
      command: parsed.command,
      ...(parsed.service === undefined ? {} : { service: parsed.service }),
      ...(parsed.user === undefined ? {} : { user: parsed.user }),
      ...(parsed.cwd === undefined ? {} : { cwd: parsed.cwd }),
    }).pipe(Effect.provide(makeLandoRuntime({ bootstrap: "app" }))),
  );
  if (Exit.isSuccess(exit)) {
    const rendered = renderExecAppResult(exit.value);
    if (rendered !== undefined) console.log(rendered);
    return;
  }
  const failure = Cause.failureOption(exit.cause);
  console.error(failure._tag === "Some" ? commandErrorMessage(failure.value) : Cause.pretty(exit.cause));
  process.exitCode = 1;
};

interface ParsedSshArgv {
  readonly service?: string;
  readonly user?: string;
  readonly subsystem?: string;
  readonly sidecar: boolean;
  readonly command: ReadonlyArray<string>;
}

const parseSshArgv = (argv: ReadonlyArray<string>): ParsedSshArgv => {
  let service: string | undefined;
  let user: string | undefined;
  let subsystem: string | undefined;
  let sidecar = false;
  const command: string[] = [];
  let i = 0;
  let positionalStarted = false;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) {
      i += 1;
      continue;
    }
    if (!positionalStarted && arg === "--") {
      positionalStarted = true;
      i += 1;
      continue;
    }
    if (!positionalStarted && (arg.startsWith("--") || (arg.startsWith("-") && arg.length > 1))) {
      const serviceMatch = parseStringFlag(argv, i, "service", "s");
      if (serviceMatch !== undefined) {
        service = serviceMatch.value;
        i += serviceMatch.consumed;
        continue;
      }
      const userMatch = parseStringFlag(argv, i, "user", "u");
      if (userMatch !== undefined) {
        user = userMatch.value;
        i += userMatch.consumed;
        continue;
      }
      const subsystemMatch = parseStringFlag(argv, i, "subsystem");
      if (subsystemMatch !== undefined) {
        subsystem = subsystemMatch.value;
        i += subsystemMatch.consumed;
        continue;
      }
      if (arg === "--sidecar") {
        sidecar = true;
        i += 1;
        continue;
      }
      positionalStarted = true;
      command.push(arg);
      i += 1;
      continue;
    }
    positionalStarted = true;
    command.push(arg);
    i += 1;
  }
  return {
    ...(service === undefined ? {} : { service }),
    ...(user === undefined ? {} : { user }),
    ...(subsystem === undefined ? {} : { subsystem }),
    sidecar,
    command,
  };
};

const sshDeferred = (kind: "subsystem" | "sidecar"): string =>
  commandErrorMessage(
    new NotImplementedError({
      message: `\`lando ssh --${kind}\`: SSH ${kind} support is deferred to Beta. Alpha \`ssh\` is provider-exec TTY command behavior only.`,
      commandId: "app:ssh",
      specSection: "spec/08-cli-and-tooling.md",
      remediation:
        "Drop the unsupported flag. Alpha `lando ssh` runs the default service shell (`sh -l`) inside the selected service via provider-exec. SSH sidecar/subsystem support lands in Beta.",
    }),
  );

const runSsh = async (argv: ReadonlyArray<string>): Promise<void> => {
  const parsed = parseSshArgv(argv);
  if (parsed.subsystem !== undefined) {
    console.error(sshDeferred("subsystem"));
    process.exitCode = 1;
    return;
  }
  if (parsed.sidecar) {
    console.error(sshDeferred("sidecar"));
    process.exitCode = 1;
    return;
  }
  const command = parsed.command.length === 0 ? ["sh", "-l"] : parsed.command;
  const exit = await Effect.runPromiseExit(
    execApp({
      command,
      interactive: true,
      tty: true,
      ...(parsed.service === undefined ? {} : { service: parsed.service }),
      ...(parsed.user === undefined ? {} : { user: parsed.user }),
    }).pipe(Effect.provide(makeLandoRuntime({ bootstrap: "app" }))),
  );
  if (Exit.isSuccess(exit)) {
    const rendered = renderExecAppResult(exit.value);
    if (rendered !== undefined) console.log(rendered);
    return;
  }
  const failure = Cause.failureOption(exit.cause);
  console.error(failure._tag === "Some" ? commandErrorMessage(failure.value) : Cause.pretty(exit.cause));
  process.exitCode = 1;
};

const parseShellService = (argv: ReadonlyArray<string>): string | undefined => {
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) {
      i += 1;
      continue;
    }
    const match = parseStringFlag(argv, i, "service", "s");
    if (match !== undefined) return match.value;
    i += 1;
  }
  return undefined;
};

const runShell = async (argv: ReadonlyArray<string>): Promise<void> => {
  const service = parseShellService(argv);
  const exit = await Effect.runPromiseExit(
    shellApp({
      ...(service === undefined ? {} : { service }),
    }).pipe(Effect.provide(makeLandoRuntime({ bootstrap: "app" }))),
  );
  if (Exit.isSuccess(exit)) {
    const rendered = renderShellAppResult(exit.value);
    if (rendered !== undefined) console.log(rendered);
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

  if (argv[0] === "destroy" || argv[0] === "app:destroy") {
    await runDestroy(argv.slice(1));
    return;
  }

  if (argv[0] === "setup" || argv[0] === "meta:setup") {
    await runSetup();
    return;
  }

  if (argv[0] === "doctor" || argv[0] === "meta:doctor") {
    await runDoctor();
    return;
  }

  if (argv[0] === "exec" || argv[0] === "app:exec") {
    await runExec(argv.slice(1));
    return;
  }

  if (argv[0] === "ssh" || argv[0] === "app:ssh") {
    await runSsh(argv.slice(1));
    return;
  }

  if (argv[0] === "shell" || argv[0] === "app:shell") {
    await runShell(argv.slice(1));
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

export const runCli = async (options: RunCliOptions): Promise<void> => {
  const entryPath = fileURLToPath(options.rootUrl);
  const args = options.argv as Array<string>;

  if (entryPath.includes("$bunfs")) {
    await runCompiledCli(options.argv);
    return;
  }

  await execute({
    dir: options.rootUrl,
    args,
  });
};
