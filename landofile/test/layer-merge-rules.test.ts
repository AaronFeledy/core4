import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";
import { loadLandofileLayers } from "../src/service.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "./support.ts";

test.each([
  {
    base: "healthcheck:\n      test: curl -f x",
    local: "healthcheck: false",
    expected: { healthcheck: false },
  },
  {
    base: "healthcheck: false",
    local: "healthcheck: curl -f x",
    expected: { healthcheck: { kind: "command", command: "curl -f x" } },
  },
  {
    dist: "healthcheck:\n      command: old",
    base: "healthcheck: false",
    local: "healthcheck:\n      kind: command",
    expected: { healthcheck: { kind: "command" } },
  },
  {
    base: "healthcheck: false",
    local: "healthcheck:\n      interval: 5s",
    expected: { healthcheck: { intervalSeconds: 5 } },
  },
  {
    base: "appMount:\n      target: /app\n      excludes:\n        - vendor",
    local: "appMount: /site",
    expected: { appMount: { target: "/site", excludes: ["vendor"] } },
  },
  {
    base: "appMount:\n      target: /app\n      excludes:\n        - vendor",
    local: "appMount: false",
    expected: { appMount: false },
  },
])("the layered loader canonicalizes shorthand overrides: $local", async (fixture) => {
  const { base, local, expected } = fixture;
  const root = await mkdtemp(join(tmpdir(), "lando-shorthand-layers-"));
  const canonical = join(root, ".lando.yml");
  try {
    if ("dist" in fixture)
      await Bun.write(join(root, ".lando.dist.yml"), `services:\n  web:\n    ${fixture.dist}\n`);
    await Bun.write(canonical, `name: layered\nservices:\n  web:\n    ${base}\n`);
    await Bun.write(join(root, ".lando.local.yml"), `services:\n  web:\n    ${local}\n`);
    const result = await Effect.runPromise(
      loadLandofileLayers(root, canonical, {
        ports: makeTestLandofilePorts(root),
        templates: { modules: [] },
        stateStore: makeTestLandofileStateStore(),
      }),
    );
    expect(result.services?.[ServiceName.make("web")]).toEqual(expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the layered loader retains the authored recipe route before template materialization", async () => {
  // Given the built-in recipe's literal both route and an unrelated local route.
  const root = await mkdtemp(join(tmpdir(), "lando-templated-route-layers-"));
  const canonical = join(root, ".lando.yml");
  try {
    await Bun.write(
      canonical,
      'name: layered\nservices:\n  web:\n    type: nginx\n    routes:\n      - hostname: "{{ app.name }}.{{ proxy.defaultDomain }}"\n        scheme: both\n',
    );
    await Bun.write(
      join(root, ".lando.local.yml"),
      "services:\n  web:\n    routes:\n      - hostname: extra.test\n",
    );
    // When the real loader merges the layers before planning materializes expressions.
    const result = await Effect.runPromise(
      loadLandofileLayers(root, canonical, {
        ports: makeTestLandofilePorts(root),
        templates: { modules: [] },
        stateStore: makeTestLandofileStateStore(),
      }),
    );
    // Then the recipe route stays authored and the extra route appends.
    expect(result.services?.[ServiceName.make("web")]?.routes).toEqual([
      { hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" },
      { hostname: "extra.test" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the layered loader preserves shorthand routes and replaces event steps", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-merge-rules-"));
  const canonical = join(root, ".lando.yml");
  try {
    await Bun.write(
      canonical,
      "name: layered\nservices:\n  web:\n    type: nginx\n    routes:\n      - web.a.test\n      - web.b.test\nevents:\n  post-start:\n    - service: web\n      cmd: old\n    - service: web\n      cmd: seed\n",
    );
    await Bun.write(
      join(root, ".lando.local.yml"),
      "services:\n  web:\n    routes:\n      - hostname: web.a.test\n        pathPrefix: /api\nevents:\n  post-start:\n    - service: web\n      cmd: echo local\n",
    );
    const result = await Effect.runPromise(
      loadLandofileLayers(root, canonical, {
        ports: makeTestLandofilePorts(root),
        templates: { modules: [] },
        stateStore: makeTestLandofileStateStore(),
      }),
    );
    expect(result.services?.[ServiceName.make("web")]?.routes).toEqual([
      "web.a.test",
      "web.b.test",
      { hostname: "web.a.test", pathPrefix: "/api" },
    ]);
    expect(result.events?.["post-start"]).toEqual([{ service: "web", cmd: "echo local" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
