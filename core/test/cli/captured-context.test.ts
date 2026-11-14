import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { Effect } from "effect";
import { rebuildToolingCache } from "../../src/cli/tooling-cache-rebuild.ts";
import { readCliAppCommandCache } from "../../src/cli/tooling-command-cache.ts";
import { CliInvocation } from "../../src/runtime/invocation-context.ts";

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
      const options = { cwd: root, cacheRoot, rebuildNotice: false };
      const read =
        mode === "read"
          ? readCliAppCommandCache(options)
          : rebuildToolingCache(
              { status: "missing", sourcePath },
              {
                ...options,
                ...(mode === "override" ? { env: { ...env, LANDO_TRACK_A_TASK: "override" } } : {}),
              },
            );
      const receipt = await Effect.runPromise(
        read.pipe(
          Effect.provideService(CliInvocation, {
            cwd: root,
            env,
            io: createBufferedRendererIO(),
            setExitCode: () => undefined,
          }),
        ),
      );
      expect(receipt.status).toBe("fresh");
      if (receipt.status !== "fresh") throw new TypeError(`Expected fresh index, received ${receipt.status}`);
      expect(receipt.payload.entries.map((entry) => entry.id)).toEqual([
        mode === "override" ? "app:override" : "app:captured",
      ]);
      expect(receipt.payload.sourceEnvironment).toMatchObject({
        _tag: "Names",
        names: ["LANDO_TRACK_A_TASK"],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  90_000,
);
