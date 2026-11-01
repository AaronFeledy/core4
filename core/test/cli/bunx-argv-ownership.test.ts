import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { applyBunCaMode, resolveBunChildCaMode } from "../../src/cli/commands/bun-child-network-policy";

describe.skipIf(process.platform === "win32")("real strict bunx argv ownership", () => {
  let root: string;
  let server: ReturnType<typeof Bun.serve>;
  let requests: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "lando-bunx-argv-"));
    requests = 0;
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        requests++;
        return new Response("unexpected registry request", { status: 401 });
      },
    });
    await mkdir(join(root, "node_modules/fixture-package"), { recursive: true });
    await mkdir(join(root, "node_modules/.bin"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "consumer", version: "1.0.0", dependencies: { "fixture-package": "1.0.0" } }),
    );
    await writeFile(
      join(root, "node_modules/fixture-package/package.json"),
      JSON.stringify({ name: "fixture-package", version: "1.0.0", bin: { "local-tool": "bin.mjs" } }),
    );
    const executable = join(root, "node_modules/fixture-package/bin.mjs");
    await writeFile(
      executable,
      "#!/usr/bin/env bun\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
    );
    await chmod(executable, 0o755);
    await symlink("../fixture-package/bin.mjs", join(root, "node_modules/.bin/local-tool"));
  });

  afterEach(async () => {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  });

  const run = async (argv: readonly string[]) => {
    const mode = resolveBunChildCaMode({
      trustHost: false,
      hasCustomCa: true,
      bundlePath: "/unused-local-only.pem",
      verb: "x",
      argv,
    });
    const projected = await Effect.runPromise(applyBunCaMode({}, argv, mode));
    const child = Bun.spawn([process.execPath, ...projected.argv], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        BUN_CONFIG_REGISTRY: server.url.href,
        BUN_INSTALL_CACHE_DIR: join(root, "bun-cache"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  };

  test.each([
    { prefix: [] },
    { prefix: ["--"] },
    { prefix: ["-p", "fixture-package"] },
    { prefix: ["--package", "fixture-package"] },
    { prefix: ["--package=fixture-package"] },
  ] as const)(
    "local tool receives exact args and makes no registry requests with prefix %j",
    async ({ prefix }) => {
      const toolArgs = [
        "--ca",
        "tool cert.pem",
        "--cafile",
        "tool-file.pem",
        "--cafile=tool.pem",
        "--no-install",
        "--install",
        "tool-value",
        "--install=force",
        "--",
        "",
      ];

      const result = await run(["x", ...prefix, "local-tool", ...toolArgs]);

      expect(result.exitCode, result.stderr).toBe(0);
      const actual: unknown = JSON.parse(result.stdout);
      expect(actual).toEqual(toolArgs);
      expect(requests).toBe(0);
    },
  );

  test("a missing tool fails without registry installation", async () => {
    const missing = `missing-tool-${crypto.randomUUID()}`;

    const result = await run(["x", missing, "--install=force"]);

    expect(result.exitCode).not.toBe(0);
    expect(requests).toBe(0);
  });
});
