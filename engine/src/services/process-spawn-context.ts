import { realpath } from "node:fs/promises";
import type { ProcessSpawnOptions } from "@lando/sdk/services";
import { createBunCommandEnv } from "./bun-command-env.ts";
import { type CapturedHostExecutionContext, prepareHostExecutionContext } from "./host-execution-context.ts";

export const prepareProcessSpawn = async (
  captured: CapturedHostExecutionContext,
  input: { readonly signal?: AbortSignal; readonly bunCommandEnv: boolean },
  lookup: (path: string) => Promise<string> = realpath,
) => {
  input.signal?.throwIfAborted();
  const context = await prepareHostExecutionContext(captured, lookup);
  input.signal?.throwIfAborted();
  const launcher = input.bunCommandEnv
    ? await createBunCommandEnv({ command: "lando", ...context })
    : { env: context.env, [Symbol.asyncDispose]: async () => {} };
  if (input.signal?.aborted) {
    await launcher[Symbol.asyncDispose]();
    input.signal.throwIfAborted();
  }
  return {
    cwd: context.cwd,
    env: launcher.env,
    [Symbol.asyncDispose]: () => launcher[Symbol.asyncDispose](),
  };
};

export const resolveProcessCgroup = (
  cgroup: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | undefined => (platform === "linux" && cgroup !== undefined && cgroup !== "" ? cgroup : undefined);

export const buildSpawnOptions = (input: ProcessSpawnOptions) => {
  const cgroup = resolveProcessCgroup(input.cgroup);
  const stdin: "pipe" | "inherit" | "ignore" =
    input.stdin !== undefined || input.stdinStream !== undefined
      ? "pipe"
      : input.inheritStdin === true
        ? "inherit"
        : "ignore";
  const output: "inherit" | "pipe" = input.inheritOutput === true ? "inherit" : "pipe";
  return {
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(cgroup === undefined ? {} : { cgroup }),
    windowsHide: input.windowsHide ?? true,
    stdin,
    stdout: output,
    stderr: output,
  };
};
