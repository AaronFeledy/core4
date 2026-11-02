import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderCompiledRecipeSnapshot } from "@lando/sdk/recipes";
import { AbsolutePath } from "@lando/sdk/schema";
import { Effect, Result } from "effect";
import { loadCompiledLandofile } from "../src/compiled-loader.ts";
import { consumeSites } from "../src/compiled-sites.ts";
import { loadAuthoredDocuments } from "../src/root-compile.ts";
import { emitCompiledLandofileYaml } from "../src/serializer.ts";
import { loadLandofileLayers } from "../src/service.ts";
import { makeTestLandofilePorts } from "./support.ts";

test("retains origins across dependency shorthand, label lists and build-argument lists", async () => {
  const compiled = await Effect.runPromise(
    loadAuthoredDocuments(
      [
        {
          file: "/app/.lando.yml",
          value: {
            services: {
              web: {
                dependsOn: ["{{ app.name }}"],
                labels: ["LABEL={{ app.name }}", "bare"],
                build: { context: ".", args: ["ARG={{ app.name }}"] },
              },
            },
          },
        },
      ],
      { appRoot: "/app", file: "/app/.lando.yml" },
    ),
  );
  expect(compiled.pendingSites.map((site) => site.path)).toEqual([
    ["services", "web", "dependsOn", 0, "service"],
    ["services", "web", "labels", "LABEL"],
    ["services", "web", "build", "args", "ARG"],
  ]);
  const resolved = consumeSites({
    document: compiled.document,
    pendingSites: compiled.pendingSites,
    context: { app: { name: "resolved" } },
    scopes: ["app"],
  });
  if (Result.isFailure(resolved)) throw resolved.failure;
  expect(resolved.success.document).toMatchObject({
    services: {
      web: {
        dependsOn: [{ service: "resolved" }],
        labels: { LABEL: "resolved", bare: "" },
        build: { args: { ARG: "resolved" } },
      },
    },
  });
});

test.each(["SecretRef", "BoundText"])("rejects loaded %s objects at the load site", async (_tag) => {
  const root = await mkdtemp(join(tmpdir(), "lando-loaded-binding-"));
  try {
    await Bun.write(join(root, "payload.json"), JSON.stringify({ _tag, reference: "DB" }));
    await Bun.write(join(root, ".lando.yml"), "x-loaded: \"{{ load('./payload.json') }}\"\n");
    const result = await Effect.runPromise(
      Effect.result(
        loadLandofileLayers(root, join(root, ".lando.yml"), {
          ports: makeTestLandofilePorts(root),
          templates: { modules: [] },
        }),
      ),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result))
      expect(result.failure).toMatchObject({
        _tag: "LandofileValidationError",
        issues: [{ path: ["x-loaded"], source: { file: join(root, ".lando.yml") } }],
      });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("serializes pending ASTs and typed references as source intent without activating literal data", async () => {
  const compiled = await Effect.runPromise(
    loadAuthoredDocuments(
      [
        {
          file: "/app/.lando.yml",
          value: {
            "x-pending": "{{ app.name }}",
            services: {
              web: {
                environment: {
                  ESCAPED: "$${secret:X}",
                  REF: "${secret:X}",
                  COMPOSITE: '{{ concat("x-", url.encodeComponent(secrets.X)) }}',
                  CURLY: "{{{{ literal",
                  DOLLAR: "$$${literal}",
                  HASH: 'pa#ss "quoted"',
                },
              },
            },
          },
        },
      ],
      { appRoot: "/app", file: "/app/.lando.yml" },
    ),
  );
  const yaml = emitCompiledLandofileYaml(compiled);
  const root = await mkdtemp(join(tmpdir(), "lando-compiled-roundtrip-"));
  try {
    await Bun.write(join(root, ".lando.yml"), yaml);
    const reloaded = await Effect.runPromise(
      loadLandofileLayers(root, join(root, ".lando.yml"), {
        ports: makeTestLandofilePorts(join(root, "cache")),
        templates: { modules: [] },
      }),
    );
    expect(reloaded.document).toEqual(compiled.document);
    expect(reloaded.pendingSites.map((site) => site.template)).toEqual(
      compiled.pendingSites.map((site) => site.template),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loads a compiled recipe carrier without compiling equal-looking option data", async () => {
  const rendered = renderCompiledRecipeSnapshot(
    {
      identity: {
        sourceKind: "bundled",
        packageName: "recipe",
        recipeId: "demo",
        manifestVersion: "1.0.0",
        contentDigest: `sha256:${"a".repeat(64)}`,
      },
      defaults: {},
      optionTypes: {},
      assets: [],
      template: {
        expression: {
          kind: "ObjectLiteral",
          entries: [
            { key: "x-authored", value: { kind: "Literal", value: "{{ app.name }}" } },
            {
              key: "x-option",
              value: { kind: "Path", head: "options", segments: [{ type: "prop", name: "text" }] },
            },
          ],
        },
      },
    },
    { text: "{{ app.name }}" },
    { appRoot: AbsolutePath.make("/app"), env: {} },
  );
  if (Result.isFailure(rendered)) throw rendered.failure;
  const loaded = await Effect.runPromise(loadCompiledLandofile(rendered.success));
  const materialized = consumeSites({
    document: loaded.document,
    pendingSites: loaded.pendingSites,
    context: { app: { name: "resolved" } },
    scopes: ["app"],
  });
  expect(Result.isSuccess(materialized)).toBe(true);
  if (Result.isSuccess(materialized))
    expect(materialized.success).toMatchObject({
      document: { "x-authored": "resolved", "x-option": "{{ app.name }}" },
      pendingSites: [],
    });
});
