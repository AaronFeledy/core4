#!/usr/bin/env bun
/**
 * Compiled CLI entry point. Keep this shell limited to fast paths and handing
 * control to `@lando/core/cli`.
 *
 * Compiled builds cannot dynamically import arbitrary paths, so bundled
 * plugins enter through the generated static table while user plugins load
 * from disk. The dispatcher owns signal handling and Effect interruption.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveLandoRoots } from "@lando/paths";

import { ensureHostProxyNoProxy } from "@lando/engine/subsystems/host-proxy/proxy-bypass";

import { cliUserArgv } from "../src/cli/user-argv";

ensureHostProxyNoProxy("127.0.0.1");
ensureHostProxyNoProxy("localhost");

const argv = cliUserArgv(Bun.argv);
const hasDiagnosticOverride = (tokens: ReadonlyArray<string>, env: NodeJS.ProcessEnv): boolean => {
  if (
    tokens.some(
      (token) =>
        token === "--debug" ||
        token === "--verbose" ||
        token === "--log-level" ||
        token.startsWith("--log-level="),
    )
  ) {
    return true;
  }
  const level = env.LANDO_LOG_LEVEL;
  return level !== undefined && level !== "" && level !== "none";
};

const writeLine = async (destination: "stdout" | "stderr", text: string): Promise<void> => {
  const { writeStdioLine } = await import("@lando/renderer/io");
  writeStdioLine(destination, text);
};
const LANDOFILE_BASENAMES = [
  ".lando.base",
  ".lando.dist",
  ".lando.upstream",
  ".lando",
  ".lando.local",
  ".lando.user",
] as const;

const hasAppContext = async (cwd: string): Promise<boolean> => {
  let current = cwd;
  for (;;) {
    const candidates = LANDOFILE_BASENAMES.flatMap((basename) => [
      join(current, `${basename}.yml`),
      join(current, `${basename}.ts`),
    ]);
    if ((await Promise.all(candidates.map((path) => Bun.file(path).exists()))).some(Boolean)) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
};

const main = async (): Promise<void> => {
  const { installBrokenPipeExitPolicy } = await import("@lando/renderer/io");
  installBrokenPipeExitPolicy();
  if (
    argv[0] === "--lando-update-replacement" &&
    argv.length === 3 &&
    argv[1] !== undefined &&
    argv[2] !== undefined
  ) {
    const { runWindowsReplacementProcess } = await import("@lando/engine/operations/update");
    const { Effect } = await import("effect");
    process.exitCode = (await Effect.runPromise(runWindowsReplacementProcess(argv[1], argv[2]))) ? 0 : 1;
    return;
  }
  if (existsSync(join(resolveLandoRoots().userCacheRoot, "update-handoff"))) {
    const { surfaceDeferredUpdateReceipts } = await import("../src/cli/update-receipts.ts");
    if (await surfaceDeferredUpdateReceipts(argv)) return;
  }
  // Only single-token forms can be remapped by commandAliases; multi-token
  // registered paths such as `recipes list` stay on the cold path in-app.
  const appSensitiveAlias =
    argv.length === 1 && ["version", "shellenv", "recipes", "--help", "-h"].includes(argv[0] ?? "");
  const appAliasContext = appSensitiveAlias && (await hasAppContext(process.cwd()));
  const coldPathAllowed = !hasDiagnosticOverride(argv, process.env);

  if (
    coldPathAllowed &&
    argv.length === 1 &&
    (argv[0] === "--version" ||
      argv[0] === "-V" ||
      argv[0] === "-v" ||
      (argv[0] === "version" && !appAliasContext))
  ) {
    const { CORE_VERSION } = await import("@lando/engine/version");
    await writeLine("stdout", CORE_VERSION);
    return;
  }

  if (
    coldPathAllowed &&
    ((argv.length === 1 && (argv[0] === "meta:shellenv" || (argv[0] === "shellenv" && !appAliasContext))) ||
      (argv.length === 2 && argv[0] === "meta" && argv[1] === "shellenv"))
  ) {
    const { defaultShellenvShell, renderShellenv } = await import("../src/cli/commands/shellenv");
    await writeLine("stdout", renderShellenv(defaultShellenvShell()));
    return;
  }

  if (
    coldPathAllowed &&
    ((argv.length === 1 &&
      (argv[0] === "meta:version" || ((argv[0] === "--help" || argv[0] === "-h") && !appAliasContext))) ||
      (argv.length === 2 && argv[0] === "meta" && argv[1] === "version"))
  ) {
    if (argv[0] === "--help" || argv[0] === "-h") {
      const { renderColdRootHelp } = await import("../src/cli/cold-path-output");
      await writeLine("stdout", renderColdRootHelp());
      return;
    }
    const { CORE_VERSION, renderMetaVersion } = await import("@lando/engine/version");
    await writeLine(
      "stdout",
      renderMetaVersion({ core: CORE_VERSION, bun: Bun.version, platform: process.platform }),
    );
    return;
  }

  if (
    coldPathAllowed &&
    ((argv.length === 1 &&
      (argv[0] === "meta:recipes:list" || (argv[0] === "recipes" && !appAliasContext))) ||
      (argv.length === 2 && argv[0] === "recipes" && argv[1] === "list") ||
      (argv.length === 3 && argv[0] === "meta" && argv[1] === "recipes" && argv[2] === "list"))
  ) {
    const { renderColdRecipesList } = await import("../src/cli/cold-path-output");
    await writeLine("stdout", renderColdRecipesList());
    return;
  }

  // Bun's compiled Windows entry can exit while CLI work waits on a promise
  // with no refed native handle. Keep dispatch alive until it fully settles.
  const keepAlive = setInterval(() => undefined, 60_000);
  let interruptedCode: 130 | 143 | undefined;
  const interrupt = (code: 130 | 143) => {
    if (interruptedCode !== undefined) return;
    interruptedCode = code;
    process.exitCode = code;
    clearInterval(keepAlive);
  };
  const onSigint = () => interrupt(130);
  const onSigterm = () => interrupt(143);
  (process as NodeJS.EventEmitter).once("SIGINT", onSigint);
  (process as NodeJS.EventEmitter).once("SIGTERM", onSigterm);
  try {
    const { runCli } = await import("@lando/core/cli");
    if (interruptedCode !== undefined) return;
    await runCli({
      argv,
      rootUrl: import.meta.url,
    });
  } finally {
    clearInterval(keepAlive);
    (process as NodeJS.EventEmitter).off("SIGINT", onSigint);
    (process as NodeJS.EventEmitter).off("SIGTERM", onSigterm);
    if (interruptedCode !== undefined) process.exitCode = interruptedCode;
  }
};

main().catch(async (error: unknown) => {
  const { BROKEN_PIPE_EXIT_CODE, isBrokenPipeError } = await import("@lando/renderer/io");
  if (isBrokenPipeError(error)) process.exit(BROKEN_PIPE_EXIT_CODE);
  await writeLine("stderr", String(error));
  process.exit(1);
});
