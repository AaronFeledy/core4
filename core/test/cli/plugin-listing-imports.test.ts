import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { createCatalogFixture } from "./fixtures/catalog-fixture.ts";

test("listing, topics and token indexing import zero bundled or external plugin entries", async () => {
  const f = await createCatalogFixture();
  const repo = resolve(import.meta.dirname, "../../..");
  try {
    await f.install("@example/trapped", [{ id: "trap:inspect", summary: "Metadata-only fixture." }]);
    const script = `
      let imports = 0;
      Bun.plugin({name: "plugin-import-trap", setup(build) {
        build.onLoad({filter: /(?:\\/plugins\\/[^/]+\\/src\\/index\\.ts|\\/.lando\\/plugins\\/[^/]+\\/index\\.ts)$/}, () => { imports++; throw new Error("plugin entry evaluated"); });
      }});
      const {runCli} = await import(${JSON.stringify(resolve(repo, "core/src/cli/index.ts"))});
      for (const argv of [["help", "--all", "--format=json"], ["help", "db"], ["help", "trap"]]) await runCli({argv, rootUrl: ${JSON.stringify(resolve(repo, "core/bin/lando.ts"))}});
      const {createPluginCommandCatalog} = await import(${JSON.stringify(resolve(repo, "core/src/cli/plugin-command-catalog.ts"))});
      const {buildCommandCatalog} = await import(${JSON.stringify(resolve(repo, "core/src/cli/command-catalog.ts"))});
      const listing = await createPluginCommandCatalog().list();
      if (buildCommandCatalog(listing.rows).resolve("trap:inspect")?.id !== "trap:inspect") throw new Error("metadata routing failed");
      console.log(JSON.stringify({entryImports: imports}));
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], {
      cwd: f.root,
      env: f.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      child.stdout.text(),
      child.stderr.text(),
    ]);
    expect(exit, stderr).toBe(0);
    expect(stdout).toContain('"entryImports":0');
    expect(stdout).toContain("Metadata-only fixture.");
  } finally {
    await f.cleanup();
  }
});
