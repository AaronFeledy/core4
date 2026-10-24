import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitYamlDocument } from "@lando/sdk/yaml";
import { Effect } from "effect";
import { appConfigLint } from "../../src/operations/app-config-lint.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";

const http = (port: number, extra: Readonly<Record<string, unknown>> = {}) => ({
  _tag: "internal",
  protocol: "http",
  port,
  ...extra,
});
test.each([
  { label: "ambiguous", endpoints: [http(80), http(90)], route: "app.lndo.site", valid: false },
  { label: "unmatched numeric", endpoints: [http(80)], route: "app.lndo.site:90", valid: false },
  {
    label: "unmatched name",
    endpoints: [http(80, { name: "web" })],
    route: { hostname: "app.lndo.site", endpoint: "admin" },
    valid: false,
  },
  {
    label: "named",
    endpoints: [http(80, { name: "web" }), http(90)],
    route: { hostname: "app.lndo.site", endpoint: "web" },
    valid: true,
  },
  { label: "numeric", endpoints: [http(80), http(90)], route: "app.lndo.site:90", valid: true },
  {
    label: "primary",
    endpoints: [http(80, { primary: true }), http(90)],
    route: "app.lndo.site",
    valid: true,
  },
  {
    label: "TCP hint",
    endpoints: [{ _tag: "internal", protocol: "tcp", port: 80, appProtocol: "http" }],
    route: "app.lndo.site",
    valid: false,
  },
  {
    label: "non-HTTP primary",
    endpoints: [{ _tag: "internal", protocol: "tcp", port: 25, primary: true }, http(80)],
    route: "app.lndo.site",
    valid: true,
  },
  {
    label: "logical facets",
    endpoints: [http(80, { name: "web" }), http(80, { _tag: "published", publication: { hostPort: 8080 } })],
    route: "app.lndo.site",
    valid: true,
  },
])("lints $label HTTP selection", async ({ endpoints, route, valid }) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-binding-selection-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      emitYamlDocument({
        name: "binding",
        services: { web: { type: "compose", image: "alpine:3", endpoints, routes: [route] } },
      }),
    );
    // When
    const result = await Effect.runPromise(
      appConfigLint({ cwd: root }).pipe(
        Effect.provide(PluginRegistryLayer.layer),
        Effect.provide(makeTestStateStore().layer),
      ),
    );
    // Then
    expect(result.valid).toBe(valid);
    expect(result.violations.map(({ rule, path }) => ({ rule, path }))).toEqual(
      valid ? [] : [{ rule: "landofile.route", path: ["services", "web", "routes", 0] }],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["local", "include", "typescript"] as const)(
  "retains indexed binding provenance from %s",
  async (origin) => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-binding-origin-"));
    try {
      const document = {
        services: {
          web: {
            type: "compose",
            image: "alpine:3",
            routes: ["bad_host!", "valid.lndo.site", "another.lndo.site"],
          },
        },
      };
      let file: string;
      switch (origin) {
        case "local":
          await writeFile(join(root, ".lando.yml"), "name: binding\n");
          file = join(root, ".lando.local.yml");
          await writeFile(file, emitYamlDocument(document));
          break;
        case "include":
          await writeFile(join(root, ".lando.yml"), "name: binding\nincludes:\n  - routes.yml\n");
          file = join(root, "routes.yml");
          await writeFile(file, emitYamlDocument(document));
          break;
        case "typescript":
          file = join(root, ".lando.ts");
          await writeFile(file, `export default ${JSON.stringify({ name: "binding", ...document })};`);
          break;
        default:
          return origin satisfies never;
      }
      // When
      const result = await Effect.runPromise(
        appConfigLint({ cwd: root }).pipe(
          Effect.provide(PluginRegistryLayer.layer),
          Effect.provide(makeTestStateStore().layer),
        ),
      );
      // Then
      expect(result.valid).toBe(false);
      expect(result.violations).toMatchObject(
        [0, 1, 2].map((index) => ({ path: ["services", "web", "routes", index] })),
      );
      for (const issue of result.violations) expect(issue.source).toMatchObject({ file });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("accumulates proxy binding failures without endpoint or missing-service cascades", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-proxy-binding-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      emitYamlDocument({
        name: "binding",
        services: {
          web: { type: "compose", image: "alpine:3", routes: ["web.lndo.site"] },
          broken: {
            type: "compose",
            image: "alpine:3",
            endpoints: [http(80, { name: "same" }), http(90, { name: "same" })],
            routes: ["broken.lndo.site"],
          },
          unavailable: { type: "unknown-service", routes: ["unknown.lndo.site"] },
        },
        proxy: { web: ["proxy.lndo.site", "second.lndo.site:9000"] },
      }),
    );
    // When
    const result = await Effect.runPromise(
      appConfigLint({ cwd: root }).pipe(Effect.provide(PluginRegistryLayer.layer)),
    );
    // Then
    expect(
      result.violations.filter(({ rule }) => rule === "landofile.route").map(({ path }) => path),
    ).toEqual([
      ["services", "web", "routes", 0],
      ["proxy", "web", 0],
      ["proxy", "web", 1],
    ]);
    expect(result.violations.filter(({ rule }) => rule === "landofile.service")).toHaveLength(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
