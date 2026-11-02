import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Result } from "effect";
import { discoverBunShellScripts } from "../src/bun-sh-discovery.ts";
import { readBunShellScript } from "../src/bun-sh-script.ts";

test.each(["discover", "read"] as const)("%s preserves script inspection failures", async (operation) => {
  const root = await mkdtemp(join(tmpdir(), "lando-script-probe-"));
  try {
    await mkdir(join(root, ".lando"));
    const scripts = join(root, ".lando", "scripts");
    if (operation === "discover") await symlink(scripts, scripts);
    else await writeFile(scripts, "not a directory");
    const result = await Effect.runPromise(
      (operation === "discover"
        ? discoverBunShellScripts({ appRoot: root }).pipe(Effect.asVoid)
        : readBunShellScript(root, "hello.bun.sh").pipe(Effect.asVoid)
      ).pipe(Effect.result),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        _tag: "BunShellScriptFrontMatterError",
        cause: { code: operation === "discover" ? "ELOOP" : "ENOTDIR" },
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
