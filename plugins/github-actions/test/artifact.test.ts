import { expect, it } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PluginManifest } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { repository, validWorkflow } from "./fixtures.ts";

const staticClosure = async (entry: string): Promise<string> => {
  const pending = [entry];
  const visited = new Set<string>();
  const sources: string[] = [];
  const scanner = new Bun.Transpiler({ loader: "js" });
  for (const file of pending) {
    if (visited.has(file)) continue;
    visited.add(file);
    const source = await Bun.file(file).text();
    sources.push(source);
    for (const edge of scanner.scanImports(source)) {
      if (edge.kind !== "dynamic-import" && edge.path.startsWith(".")) {
        pending.push(resolve(file, "..", edge.path));
      }
    }
  }
  return sources.join("\n");
};

it("ships a split artifact with truthful install metadata, cold help, and working public operations", async () => {
  // Given the optional package's normal host build and an isolated workflow repository.
  await using repo = await repository({ "ci.yml": validWorkflow });
  const build = Bun.spawn([process.execPath, "run", "build:artifact"], {
    cwd: resolve(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
    build.exited,
  ]);
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0);

  // When consumers load the emitted package and its public operations.
  const dist = resolve(import.meta.dir, "../dist");
  const installed: unknown = await Bun.file(resolve(dist, "package.json")).json();
  if (typeof installed !== "object" || installed === null || !("landoPlugin" in installed)) {
    throw new TypeError("Artifact must carry its installed manifest");
  }
  const manifest = Schema.decodeUnknownSync(PluginManifest)(installed.landoPlugin);
  const descriptor: typeof import("../src/index.ts") = await import(
    pathToFileURL(resolve(dist, "index.js")).href
  );
  const operations: typeof import("../src/operations.ts") = await import(
    pathToFileURL(resolve(dist, "operations.js")).href
  );
  const result = await Effect.runPromise(operations.listWorkflows({ root: repo.root }));

  // Then runtime entry metadata is artifact-relative and parser code stays off descriptor/help's static graph.
  expect(manifest.entry).toBe("./index.js");
  const { entry: _entry, ...descriptorManifest } = manifest;
  expect(descriptor.manifest).toEqual(descriptorManifest);
  expect(result.summary).toEqual({ discovered: 1, inspected: 1, failed: 0, uninspected: 0 });
  const rootSource = await Bun.file(resolve(dist, "index.js")).text();
  const command = new Bun.Transpiler({ loader: "js" })
    .scanImports(rootSource)
    .find((edge) => edge.kind === "dynamic-import");
  if (command === undefined) throw new TypeError("Artifact must retain a lazy command chunk");
  const heavyModule =
    /^\/\/ .*?(?:node_modules\/(?:@actions|yaml)\/|src\/(?:inspect|acquisition|preflight|bounded-read)\.ts)/mu;
  expect(await staticClosure(resolve(dist, "index.js"))).not.toMatch(heavyModule);
  expect(await staticClosure(resolve(dist, command.path))).not.toMatch(heavyModule);
  expect(await staticClosure(resolve(dist, "operations.js"))).toMatch(heavyModule);
}, 30_000);
