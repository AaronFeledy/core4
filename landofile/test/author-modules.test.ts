import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as sdk from "@lando/sdk";
import { Effect, Predicate } from "effect";
import { importAuthorModule } from "../src/author-modules.ts";
import { hostModules } from "../src/host-module-table.ts";

test("author imports share host functions, schemas and tags outside node_modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-author-"));
  try {
    for (let parent = root; ; parent = dirname(parent)) {
      expect(existsSync(join(parent, "node_modules"))).toBe(false);
      if (parent === dirname(parent)) break;
    }
    const path = join(root, "author.ts");
    await Bun.write(
      path,
      `
      import * as landofile from "@lando/sdk/landofile";
      import { ServiceConfig } from "@lando/sdk/schema";
      import { LandofileService } from "@lando/sdk/services";
      import { Effect } from "effect";
      import * as EffectModule from "effect/Effect";
      export { defineLandofile } from "@lando/sdk";
      export const values = { landofile, ServiceConfig, LandofileService, succeed: EffectModule.succeed, value: Effect.succeed(42) };
    `,
    );
    const loaded = await importAuthorModule(path);
    if (!Predicate.hasProperty(loaded, "values") || !Predicate.hasProperty(loaded, "defineLandofile"))
      throw new Error("missing module exports");
    expect(loaded.defineLandofile).toBe(sdk.defineLandofile);
    const values = loaded.values;
    if (
      !Predicate.hasProperty(values, "ServiceConfig") ||
      !Predicate.hasProperty(values, "LandofileService") ||
      !Predicate.hasProperty(values, "succeed") ||
      !Predicate.hasProperty(values, "value")
    )
      throw new Error("missing identity exports");
    expect(values.ServiceConfig).toBe(sdk.Schema.ServiceConfig);
    expect(values.LandofileService).toBe(sdk.Services.LandofileService);
    expect(values.succeed).toBe(Effect.succeed);
    expect(Effect.isEffect(values.value)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("host ids cover SDK exports and bundled plugin peer imports", async () => {
  const manifest = await Bun.file(join(import.meta.dir, "../../sdk/package.json")).json();
  const expected = Object.keys(manifest.exports)
    .filter((key) => key !== "./test" && key !== "./docs/components")
    .map((key) => (key === "." ? "@lando/sdk" : `@lando/sdk/${key.slice(2)}`))
    .sort();
  expect(
    Object.keys(hostModules)
      .filter((id) => id.startsWith("@lando/sdk"))
      .sort(),
  ).toEqual(expected);
  for await (const path of new Bun.Glob("plugins/*/src/**/*.{ts,tsx,js}").scan({
    cwd: join(import.meta.dir, "../.."),
    absolute: true,
  })) {
    const scanner = new Bun.Transpiler({ loader: path.endsWith(".tsx") ? "tsx" : "ts" });
    for (const entry of scanner.scan(await Bun.file(path).text()).imports) {
      if (entry.path.startsWith("@lando/sdk") || entry.path.startsWith("effect/")) {
        expect(hostModules[entry.path], `${path}: ${entry.path}`).toBeDefined();
      }
    }
  }
});

for (const scenario of ["concurrent", "competing", "contribution"] as const) {
  test(`first ${scenario} author imports preserve host identity in a fresh process`, async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-author-process-"));
    try {
      const author = join(root, "contribution.ts");
      await Bun.write(
        author,
        `
        export { defineLandofile } from "@lando/sdk";
        export { ServiceConfig } from "@lando/sdk/schema";
        export { LandofileService } from "@lando/sdk/services";
        export { definePlugin } from "@lando/sdk/plugins";
        export { succeed } from "effect/Effect";
        export { HttpClient } from "effect/http/HttpClient";
      `,
      );
      if (scenario === "competing") {
        for (const name of ["@lando/sdk", "effect"]) {
          await Bun.write(
            join(root, "node_modules", name, "package.json"),
            JSON.stringify({ name, type: "module", exports: { ".": "./index.js", "./*": "./index.js" } }),
          );
          await Bun.write(
            join(root, "node_modules", name, "index.js"),
            'throw new Error("plugin-local peer evaluated");',
          );
        }
      }
      const driver = `
        import { importAuthorModule, ensureHostModules } from ${JSON.stringify(join(import.meta.dir, "../src/author-modules.ts"))};
        import * as sdk from ${JSON.stringify(join(import.meta.dir, "../../sdk/src/index.ts"))};
        import { Effect } from ${JSON.stringify(Bun.resolveSync("effect", import.meta.dir))};
        import { HttpClient } from ${JSON.stringify(Bun.resolveSync("effect/http/HttpClient", import.meta.dir))};
        const first = ensureHostModules();
        if (first !== ensureHostModules()) throw new Error("registration is not single-flight");
        const modules = await Promise.all(Array.from({ length: ${scenario === "concurrent" ? 8 : 1} }, (_, i) => importAuthorModule(${JSON.stringify(author)} + "?i=" + i)));
        for (const m of modules) {
          if (m.defineLandofile !== sdk.defineLandofile || m.ServiceConfig !== sdk.Schema.ServiceConfig || m.LandofileService !== sdk.Services.LandofileService || m.succeed !== Effect.succeed || m.HttpClient !== HttpClient) throw new Error("host identity mismatch");
        }
      `;
      const child = Bun.spawn([process.execPath, "--eval", driver], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
