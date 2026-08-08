#!/usr/bin/env bun
/**
 * Compiled CLI entry point. Keep this shell limited to fast paths and handing
 * control to `@lando/core/cli`.
 *
 * Compiled builds cannot dynamically import arbitrary paths, so bundled
 * plugins enter through the generated static table while user plugins load
 * from disk. The dispatcher owns signal handling and Effect interruption.
 */

import { ensureHostProxyNoProxy } from "@lando/engine/subsystems/host-proxy/proxy-bypass";

ensureHostProxyNoProxy("127.0.0.1");
ensureHostProxyNoProxy("localhost");

const argv = Bun.argv.slice(2);

const main = async (): Promise<void> => {
  if (
    argv.length === 1 &&
    (argv[0] === "--version" || argv[0] === "-V" || argv[0] === "-v" || argv[0] === "version")
  ) {
    const { CORE_VERSION } = await import("@lando/engine/version");
    console.log(CORE_VERSION);
    return;
  }

  if (
    (argv.length === 1 && (argv[0] === "shellenv" || argv[0] === "meta:shellenv")) ||
    (argv.length === 2 && argv[0] === "meta" && argv[1] === "shellenv")
  ) {
    const { renderShellenv } = await import("../src/cli/commands/shellenv");
    console.log(renderShellenv("posix"));
    return;
  }

  if (
    (argv.length === 1 && (argv[0] === "meta:version" || argv[0] === "--help" || argv[0] === "-h")) ||
    (argv.length === 2 && argv[0] === "meta" && argv[1] === "version")
  ) {
    if (argv[0] === "--help" || argv[0] === "-h") {
      const { renderColdRootHelp } = await import("../src/cli/cold-path-output");
      console.log(renderColdRootHelp());
      return;
    }
    const { CORE_VERSION, renderMetaVersion } = await import("@lando/engine/version");
    console.log(renderMetaVersion({ core: CORE_VERSION, bun: Bun.version, platform: process.platform }));
    return;
  }

  if (
    (argv.length === 1 && (argv[0] === "recipes" || argv[0] === "meta:recipes:list")) ||
    (argv.length === 2 && argv[0] === "recipes" && argv[1] === "list") ||
    (argv.length === 3 && argv[0] === "meta" && argv[1] === "recipes" && argv[2] === "list")
  ) {
    const { renderColdRecipesList } = await import("../src/cli/cold-path-output");
    console.log(renderColdRecipesList());
    return;
  }

  const { runCli } = await import("@lando/core/cli");

  await runCli({
    argv,
    rootUrl: import.meta.url,
  });
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
