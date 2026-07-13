import { NotImplementedError } from "@lando/sdk/errors";

import { cliRuntimeOptions } from "../../runtime/cli-options.ts";
import { makeLandoRuntime } from "../../runtime/layer.ts";
import { execApp, renderExecAppResult } from "../commands/exec.ts";
import { renderShellAppResult, shellApp } from "../commands/shell.ts";
import {
  commandErrorMessage,
  emitDiagnosticLine,
  rejectInvalidInvocation,
  runCompiledCommand,
} from "../compiled-runtime.ts";

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

export const runExec = (argv: ReadonlyArray<string>): Promise<void> => {
  const parsed = parseExecArgv(argv);
  return runCompiledCommand(
    execApp({
      command: parsed.command,
      ...(parsed.service === undefined ? {} : { service: parsed.service }),
      ...(parsed.user === undefined ? {} : { user: parsed.user }),
      ...(parsed.cwd === undefined ? {} : { cwd: parsed.cwd }),
    }),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "app", plugins: { policy: "discovery" } })),
    renderExecAppResult,
  );
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
      remediation:
        "Drop the unsupported flag. Alpha `lando ssh` runs the default service shell (`sh -l`) inside the selected service via provider-exec. SSH sidecar/subsystem support lands in Beta.",
    }),
  );

export const runSsh = async (argv: ReadonlyArray<string>): Promise<void> => {
  const parsed = parseSshArgv(argv);
  if (parsed.subsystem !== undefined) {
    emitDiagnosticLine(sshDeferred("subsystem"));
    process.exitCode = 1;
    return;
  }
  if (parsed.sidecar) {
    emitDiagnosticLine(sshDeferred("sidecar"));
    process.exitCode = 1;
    return;
  }
  const command = parsed.command.length === 0 ? ["sh", "-l"] : parsed.command;
  await runCompiledCommand(
    execApp({
      command,
      interactive: true,
      tty: true,
      ...(parsed.service === undefined ? {} : { service: parsed.service }),
      ...(parsed.user === undefined ? {} : { user: parsed.user }),
    }),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "app", plugins: { policy: "discovery" } })),
    renderExecAppResult,
  );
};

const parseShellArgv = (
  argv: ReadonlyArray<string>,
): {
  readonly service?: string;
  readonly host: boolean;
  readonly noHistory: boolean;
  readonly noInteractive: boolean;
} => {
  let service: string | undefined;
  let host = false;
  let noHistory = false;
  let noInteractive = false;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) {
      i += 1;
      continue;
    }
    if (arg === "--host") {
      host = true;
      i += 1;
      continue;
    }
    if (arg === "--no-history") {
      noHistory = true;
      i += 1;
      continue;
    }
    if (arg === "--no-interactive") {
      noInteractive = true;
      i += 1;
      continue;
    }
    const match = parseStringFlag(argv, i, "service", "s");
    if (match !== undefined) {
      service = match.value;
      i += match.consumed;
      continue;
    }
    i += 1;
  }
  return { ...(service === undefined ? {} : { service }), host, noHistory, noInteractive };
};

export const runShell = (
  argv: ReadonlyArray<string>,
  options: { readonly signal?: AbortSignal } = {},
): Promise<void> => {
  if (rejectInvalidInvocation("app:shell", argv)) return Promise.resolve();
  const parsed = parseShellArgv(argv);
  return runCompiledCommand(
    shellApp({
      host: parsed.host,
      noHistory: parsed.noHistory,
      noInteractive: parsed.noInteractive,
      ...(parsed.service === undefined ? {} : { service: parsed.service }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }),
    makeLandoRuntime(cliRuntimeOptions({ bootstrap: "app", plugins: { policy: "discovery" } })),
    renderShellAppResult,
  );
};
