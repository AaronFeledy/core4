#!/usr/bin/env bun
/**
 * Compiled CLI entry point. Keep this shell limited to fast paths and handing
 * control to `@lando/core/cli`.
 *
 * Compiled builds cannot dynamically import arbitrary paths, so bundled
 * plugins enter through the generated static table while user plugins load
 * from disk. The dispatcher owns signal handling and Effect interruption.
 */

import { ensureHostProxyNoProxy } from "../src/subsystems/host-proxy/proxy-bypass.ts";

ensureHostProxyNoProxy("127.0.0.1");
ensureHostProxyNoProxy("localhost");

const argv = Bun.argv.slice(2);

const main = async (): Promise<void> => {
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "version")) {
    const { CORE_VERSION } = await import("../src/version.ts");
    console.log(CORE_VERSION);
    process.exit(0);
  }

  if (argv.length === 1 && argv[0] === "shellenv") {
    const { renderShellenv } = await import("../src/cli/commands/shellenv.ts");
    console.log(renderShellenv("posix"));
    process.exit(0);
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
