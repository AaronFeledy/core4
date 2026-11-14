import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cliRoot = resolve(import.meta.dirname, "../../src");

// Loading a TypeScript Landofile registers process-wide host modules, so each case runs in a child process.
test.each(["read", "rebuild", "override"] as const)(
  "%s tooling rebuild loads TypeScript from the captured environment and roots",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "lando-captured-rebuild-"));
    const cacheRoot = join(root, "cache");
    const sourcePath = join(root, ".lando.ts");
    const env = {
      ...process.env,
      LANDO_USER_CACHE_ROOT: cacheRoot,
      LANDO_USER_DATA_ROOT: join(root, "data"),
      LANDO_USER_CONF_ROOT: join(root, "conf"),
      LANDO_TRACK_A_TASK: "captured",
    };
    try {
      await writeFile(
        sourcePath,
        `export default (ctx) => ({
  name: "captured",
  tooling: { [ctx.env.LANDO_TRACK_A_TASK]: { cmd: "echo ok", arguments: false } },
});\n`,
      );
      const script = `
        const { Effect } = await import("effect");
        const { createBufferedRendererIO } = await import("@lando/renderer/io");
        const { rebuildToolingCache } = await import(${JSON.stringify(resolve(cliRoot, "cli/tooling-cache-rebuild.ts"))});
        const { readCliAppCommandCache } = await import(${JSON.stringify(resolve(cliRoot, "cli/tooling-command-cache.ts"))});
        const { CliInvocation } = await import(${JSON.stringify(resolve(cliRoot, "runtime/invocation-context.ts"))});
        const mode = ${JSON.stringify(mode)};
        const env = ${JSON.stringify(env)};
        const options = { cwd: ${JSON.stringify(root)}, cacheRoot: ${JSON.stringify(cacheRoot)}, rebuildNotice: false };
        const read = mode === "read"
          ? readCliAppCommandCache(options)
          : rebuildToolingCache(
              { status: "missing", sourcePath: ${JSON.stringify(sourcePath)} },
              { ...options, ...(mode === "override" ? { env: { ...env, LANDO_TRACK_A_TASK: "override" } } : {}) },
            );
        const receipt = await Effect.runPromise(read.pipe(Effect.provideService(CliInvocation, {
          cwd: options.cwd, env, io: createBufferedRendererIO(), setExitCode: () => undefined,
        })));
        console.log(JSON.stringify(receipt.status === "fresh"
          ? { status: receipt.status, ids: receipt.payload.entries.map((entry) => entry.id), sourceEnvironment: receipt.payload.sourceEnvironment }
          : { status: receipt.status }));
      `;
      const child = Bun.spawn([process.execPath, "--eval", script], {
        cwd: resolve(import.meta.dirname, "../.."),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        child.stdout.text(),
        child.stderr.text(),
      ]);
      expect(exit, stderr).toBe(0);
      const receipt = JSON.parse(stdout);
      expect(receipt).toMatchObject({
        status: "fresh",
        ids: [mode === "override" ? "app:override" : "app:captured"],
        sourceEnvironment: { _tag: "Names", names: ["LANDO_TRACK_A_TASK"] },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  90_000,
);
