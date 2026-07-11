#!/usr/bin/env bun
/**
 * Lando v4 CLI entry point.
 *
 * This is the imperative shell consumed by `bun build --compile` to produce
 * the single-binary release artifact. It MUST stay tiny — the only
 * responsibility here is to hand control to the OCLIF adapter inside
 * `@lando/core/cli`, which then bridges into the Effect runtime.
 *
 * Notes:
 * - Compiled-binary constraints forbid dynamic `import()` of arbitrary paths
 *   at runtime. Bundled plugins are statically imported via the generated
 *   `src/plugins/bundled.ts`. User-installed plugins load from disk outside
 *   the binary using Bun's runtime loader.
 * - SIGINT handling and bridge-to-Effect-interrupt happen inside
 *   `@lando/core/cli`. This file does not install signal handlers directly.
 */

import { basename } from "node:path";
import { pathToFileURL } from "node:url";

import { ensureHostProxyNoProxy } from "../src/subsystems/host-proxy/proxy-bypass.ts";

ensureHostProxyNoProxy("127.0.0.1");
ensureHostProxyNoProxy("localhost");

const argv = Bun.argv.slice(2);

const hasHostProxyShimEnv = (): boolean =>
  (process.env.LANDO_HOST_PROXY_SOCKET?.length ?? 0) > 0 ||
  (process.env.LANDO_HOST_PROXY_URL?.length ?? 0) > 0;

const main = async (): Promise<void> => {
  if (hasHostProxyShimEnv()) {
    await import("../src/subsystems/host-proxy/shim-bin.ts");
    return;
  }

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
  const execName = basename(process.execPath).toLowerCase();
  const isCompiledExecutable = execName !== "bun" && execName !== "bun.exe";
  const rootUrl = isCompiledExecutable ? pathToFileURL(process.execPath).href : import.meta.url;

  await runCli({
    argv,
    rootUrl,
  });
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
