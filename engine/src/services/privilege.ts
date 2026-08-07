import { join } from "node:path";

import { Effect, Layer } from "effect";

import type { ProcessResult } from "@lando/sdk/services";
import { PrivilegeService } from "@lando/sdk/services";

interface PrivilegeSpawnOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
}

interface PrivilegeSpawnPlan {
  readonly cmd: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Record<string, string>;
}

const resultFromFailure = (command: ReadonlyArray<string>, cause: unknown): ProcessResult => ({
  exitCode: 127,
  stdout: "",
  stderr: cause instanceof Error ? cause.message : `Failed to run ${command[0] ?? "command"}`,
});

const existingAskpassHelper = async (
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string | undefined> => {
  if (env.SUDO_ASKPASS !== undefined && (await Bun.file(env.SUDO_ASKPASS).exists())) {
    return env.SUDO_ASKPASS;
  }
  const home = env.HOME;
  if (home === undefined) return undefined;
  const localHelper = join(home, "scripts", "sudo-askpass.sh");
  return (await Bun.file(localHelper).exists()) ? localHelper : undefined;
};

export const sudoSpawnForPrivilege = async (
  command: ReadonlyArray<string>,
  options: PrivilegeSpawnOptions = {},
): Promise<PrivilegeSpawnPlan> => {
  const platform = options.platform ?? process.platform;
  const [cmd = "", ...args] = command;
  if (platform !== "linux") return { cmd, args, env: {} };

  const askpass = await existingAskpassHelper(options.env);
  if (command[0] === "sudo") {
    const sudoArgs = command.slice(1).filter((arg) => arg !== "-A" && arg !== "-n");
    return askpass === undefined
      ? { cmd: "sudo", args: ["-n", ...sudoArgs], env: {} }
      : { cmd: "sudo", args: ["-A", ...sudoArgs], env: { SUDO_ASKPASS: askpass } };
  }

  return askpass === undefined
    ? { cmd: "sudo", args: ["-n", ...command], env: {} }
    : { cmd: "sudo", args: ["-A", ...command], env: { SUDO_ASKPASS: askpass } };
};

const runElevated = async (command: ReadonlyArray<string>): Promise<ProcessResult> => {
  const prepared = await sudoSpawnForPrivilege(command);
  const proc = Bun.spawn([prepared.cmd, ...prepared.args], {
    env: { ...process.env, ...prepared.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

export const PrivilegeServiceLive = Layer.succeed(PrivilegeService, {
  elevate: (command) =>
    Effect.tryPromise({
      try: () => runElevated(command),
      catch: (cause) => resultFromFailure(command, cause),
    }).pipe(Effect.catchAll((result) => Effect.succeed(result))),
});
