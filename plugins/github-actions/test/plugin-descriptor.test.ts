import { expect, it } from "bun:test";
import { resolve } from "node:path";
import { PluginManifest } from "@lando/sdk/schema";
import { runPluginContract } from "@lando/sdk/test";
import { Effect, Schema } from "effect";
import packageJson from "../package.json";
import * as entry from "../src/index.ts";

it("registers a valid optional descriptor and one lazy command", async () => {
  await Effect.runPromise(runPluginContract({ manifest: entry.manifest }));
  expect(entry.manifest.contributes?.commands).toEqual(["github-actions:list"]);
  const command = await entry.plugin.commands?.get("github-actions:list")?.();
  expect(command?.id).toBe("github-actions:list");
  expect(command?.bootstrap).toBe("minimal");
});

it("ships matching installed-loader, YAML, and exported manifests", async () => {
  const yaml = Bun.YAML.parse(await Bun.file(resolve(import.meta.dir, "../plugin.yaml")).text());
  const strict = Schema.decodeUnknownSync(PluginManifest);
  const sourceManifest = strict(packageJson.landoPlugin, { onExcessProperty: "error" });
  const { entry: _entry, ...descriptorManifest } = sourceManifest;
  expect(strict(yaml, { onExcessProperty: "error" })).toEqual(sourceManifest);
  expect(descriptorManifest).toEqual(entry.manifest);
});

it("publishes only inspection operations and exact language pins", async () => {
  const operations = await import("@lando/github-actions/operations");
  expect(operations.listWorkflows).toBeFunction();
  expect(Object.keys(packageJson.exports).sort()).toEqual([".", "./errors", "./operations", "./schema"]);
  expect(packageJson.dependencies["@actions/workflow-parser"]).toBe("0.3.61");
  expect(packageJson.dependencies.yaml).toBe("2.9.1");
  expect(Object.keys(packageJson.dependencies).filter((name) => name.startsWith("@lando/"))).toEqual([
    "@lando/sdk",
  ]);
});

it("keeps parser and filesystem implementations outside the root and loaded help closure", async () => {
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../src/index.ts"), resolve(import.meta.dir, "../src/command.ts")],
    target: "bun",
    metafile: true,
    external: ["effect", "@lando/sdk/*"],
    plugins: [
      {
        name: "static-help-closure",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) =>
            args.kind === "dynamic-import" ? { path: args.path, external: true } : undefined,
          );
        },
      },
    ],
  });
  expect(build.success).toBe(true);
  const inputs = Object.keys(build.metafile?.inputs ?? {});
  expect(inputs.some((path) => path.endsWith("/src/command.ts"))).toBe(true);
  expect(
    inputs.some((path) => /(?:@actions|\/yaml\/|acquisition|inspect\.ts|preflight|bounded-read)/u.test(path)),
  ).toBe(false);
});
