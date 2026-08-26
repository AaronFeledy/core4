#!/usr/bin/env bun
/**
 * Compiled CLI entry point. Keep this shell limited to fast paths and handing
 * control to `@lando/core/cli`.
 *
 * Compiled builds cannot dynamically import arbitrary paths, so bundled
 * plugins enter through the generated static table while user plugins load
 * from disk. The dispatcher owns signal handling and Effect interruption.
 */

import { dirname, join } from "node:path";

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
    const { renderShellenv } = await import("../src/cli/commands/shellenv");
    await writeLine("stdout", renderShellenv("posix"));
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

  const { runCli } = await import("@lando/core/cli");

  await runCli({
    argv,
    rootUrl: import.meta.url,
  });
};

main().catch(async (error: unknown) => {
  await writeLine("stderr", String(error));
  process.exit(1);
});
