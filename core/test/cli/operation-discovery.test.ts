import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeAppCommandCacheStrict } from "@lando/engine/cache/command-index-writer";
import { Effect } from "effect";

test("one walk spans the cold check, alias routing, bootstrap, and command execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-cli-operation-discovery-"));
  const app = join(root, "app");
  const cwd = join(app, "a/b/c/d/e/f");
  await mkdir(cwd, { recursive: true });
  await writeFile(
    join(app, ".lando.yml"),
    "name: discovery-once\nservices: {}\ncommandAliases:\n  custom:\n    version: app:config\n",
  );
  const repo = resolve(import.meta.dir, "../..");
  const preload = join(root, "count-walks.ts");
  const receipt = join(root, "walks.json");
  await writeFile(receipt, "0");
  await Effect.runPromise(
    writeAppCommandCacheStrict({
      cwd,
      cacheRoot: join(root, "cache"),
      landofile: { name: "discovery-once", commandAliases: { custom: { version: "app:config" } } },
      entries: [],
    }),
  );
  await writeFile(
    preload,
    `
import { dirname } from "node:path";
Bun.plugin({ name: "count-app-walks", setup(build) {
  build.onLoad({ filter: /traversal-policy\\.ts$/ }, async (args) => {
    const contents = (await Bun.file(args.path).text()).replace(
      "let directory = resolve(cwd);",
      ${JSON.stringify(`await Bun.write(${JSON.stringify(receipt)}, String(Number(await Bun.file(${JSON.stringify(receipt)}).text()) + 1)); let directory = resolve(cwd);`)}
    );
    return { contents, loader: "ts", resolveDir: dirname(args.path) };
  });
}});
`,
  );
  try {
    const child = Bun.spawn([process.execPath, "--preload", preload, join(repo, "bin/lando.ts"), "version"], {
      cwd,
      env: {
        ...process.env,
        LANDO_USER_CONF_ROOT: join(root, "conf"),
        LANDO_USER_DATA_ROOT: join(root, "data"),
        LANDO_USER_CACHE_ROOT: join(root, "cache"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain("discovery-once");
    expect(await Bun.file(receipt).json()).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
