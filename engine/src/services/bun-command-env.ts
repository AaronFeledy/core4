import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quoteShellPath } from "./shell-quote.ts";

export interface BunCommandRuntime {
  readonly platform: NodeJS.Platform;
  readonly execPath: string;
  readonly standalone: boolean;
}

const bunCommandRuntime = (): BunCommandRuntime => ({
  platform: process.platform,
  execPath: process.execPath,
  standalone: Bun.isStandaloneExecutable,
});

export const landoLauncher = (target: string, platform: NodeJS.Platform) =>
  commandLauncher("lando", target, platform);

export const commandLauncher = (name: "lando" | "bun", target: string, platform: NodeJS.Platform) =>
  platform === "win32"
    ? {
        name: `${name}.cmd`,
        content: [
          "@echo off",
          "setlocal DisableDelayedExpansion",
          name === "lando" ? 'set "BUN_BE_BUN="' : 'set "BUN_BE_BUN=1"',
          ...(name === "lando" ? ['set "BUN_FEATURE_FLAG_NO_ORPHANS="'] : []),
          `"${target.replaceAll("%", "%%")}" %*`,
          "exit /b %errorlevel%",
          "",
        ].join("\r\n"),
      }
    : {
        name,
        content: `#!/bin/sh\n${name === "lando" ? "unset BUN_BE_BUN BUN_FEATURE_FLAG_NO_ORPHANS" : "export BUN_BE_BUN=1"}\nexec ${quoteShellPath(target)} "$@"\n`,
      };

export const launcherPathEnv = (
  env: Readonly<Record<string, string>>,
  directory: string,
  runtime: { readonly platform: NodeJS.Platform; readonly placement: "prepend" | "append" },
): Record<string, string> => {
  const { key, value } = commandPath(env, runtime.platform);
  const result = { ...env };
  for (const entry of Object.keys(result).filter((entry) => isPathKey(entry, runtime.platform)))
    delete result[entry];
  const separator = runtime.platform === "win32" ? ";" : ":";
  // An empty PATH entry means the cwd, so an empty PATH must not gain a separator.
  result[key] = directory;
  if (value !== "") {
    result[key] =
      runtime.placement === "prepend"
        ? `${directory}${separator}${value}`
        : `${value}${separator}${directory}`;
  }
  return result;
};

const isPathKey = (key: string, platform: NodeJS.Platform): boolean =>
  platform === "win32" ? key.toUpperCase() === "PATH" : key === "PATH";

const commandPath = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => {
  const callerKey = Object.keys(env).find((key) => isPathKey(key, platform));
  const key = Object.keys(process.env).find((key) => isPathKey(key, platform)) ?? "PATH";
  return { key, value: (callerKey === undefined ? process.env[key] : env[callerKey]) ?? "" };
};

export const inheritCommandEnv = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv => {
  const path = commandPath(env, platform);
  const result = { ...process.env, ...env };
  for (const key of Object.keys(result).filter((key) => isPathKey(key, platform))) delete result[key];
  result[path.key] = path.value;
  return result;
};

export const createBunCommandEnv = async (
  options: {
    readonly command: "lando" | "bun";
    readonly env: Readonly<Record<string, string>>;
    readonly cwd?: string;
  },
  runtime: BunCommandRuntime = bunCommandRuntime(),
): Promise<{ readonly env: Record<string, string>; readonly [Symbol.asyncDispose]: () => Promise<void> }> => {
  const effectivePath = commandPath(options.env, runtime.platform).value;
  const fallback = runtime.standalone ? runtime.execPath : undefined;
  const target =
    options.command === "lando"
      ? (Bun.which("lando", { PATH: effectivePath, cwd: options.cwd ?? process.cwd() }) ?? fallback)
      : fallback;
  if (target === undefined) return { env: { ...options.env }, [Symbol.asyncDispose]: async () => {} };
  const directory = await mkdtemp(join(tmpdir(), "lando-script-bin-"));
  const dispose = () => rm(directory, { recursive: true, force: true });
  try {
    const launcher = commandLauncher(options.command, target, runtime.platform);
    await writeFile(join(directory, launcher.name), launcher.content, { mode: 0o700 });
    return {
      env: launcherPathEnv(options.env, directory, {
        platform: runtime.platform,
        placement: options.command === "lando" ? "prepend" : "append",
      }),
      [Symbol.asyncDispose]: dispose,
    };
  } catch (cause) {
    await dispose();
    throw cause;
  }
};
