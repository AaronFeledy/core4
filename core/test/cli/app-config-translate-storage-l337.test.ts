import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { appConfigLint } from "@lando/engine/operations/app-config-lint";
import { layerWith as pluginRegistryLayer } from "@lando/engine/plugins/registry";
import * as AppPlannerLayer from "@lando/engine/services/planner";
import { parseLandofile } from "@lando/landofile/parser";
import { loadAuthoredDocuments } from "@lando/landofile/root-compile";
import { ServiceName } from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer } from "effect";
import { withCwd } from "../_support/temp-cwd.ts";
import { withFixture } from "./translate-lando3-fixture.ts";

const bundledCatalog = pluginRegistryLayer({ user: false, app: false });

test.each([
  ["Storage QA", "storage-qa"],
  ["Other App", "other-app"],
])("plans app-qualified storage and bare l337 behavior for %s", async (name, slug) => {
  await withFixture(async ({ root, run }) => {
    // Given two services sharing some volumes, but not their service-scoped /data.
    await rm(join(root, ".lando.recipe.yml"));
    await rm(join(root, ".lando.local.yml"));
    const file = join(root, ".lando.yml");
    await Bun.write(
      file,
      `name: ${name}
services:
  web:
    api: 4
    image: alpine:3.21
    storage:
      - /data
      - {target: /shared, scope: app}
      - {target: /explicit, source: authored-volume}
      - {target: /empty, source: ''}
      - {target: /cacheData, source: false}
  worker:
    api: 4
    image: alpine:3.21
    storage:
      - /data
      - {target: /shared, scope: project}
      - {target: /explicit, source: authored-volume}
  tool:
    api: 4
    type: l337
    image: alpine:3.21
    user: root
    command: [sleep, infinity]
    entrypoint: [/bin/sh, -c]
    environment: {A: '1'}
    primary: false
    labels: {purpose: qa}
    hostnames: [tool.test]
    certs: false
    home: false
    scanner: false
    security: {ca: []}
    mounts: ['./conf:/etc/qa']
    storage: [{source: tool-data, target: /tool-data}]
    ports: ['8080:80']
    volumes: ['.:/src', './data:/data']
    working_dir: /src
    healthcheck: echo ignored
  bare:
    api: 4
    type: l337
    image:
      imagefile: FROM alpine:3.21
    command: [sleep, infinity]
`,
    );
    // When converting, strictly linting, and planning with the real bundled catalog.
    const translated = await Effect.runPromise(run());
    if (translated.mode !== "preview") throw new Error("Expected translation preview");
    const target = translated.targets[0];
    if (target === undefined) throw new Error("Missing translated Landofile");
    await Bun.write(file, target.content);
    const lint = await Effect.runPromise(appConfigLint({ cwd: root }).pipe(Effect.provide(bundledCatalog)));
    const parsed = await Effect.runPromise(parseLandofile({ file, content: target.content, cwd: root }));
    const compiled = await Effect.runPromise(
      loadAuthoredDocuments([{ file, value: parsed }], { appRoot: root, file }),
    );
    const plan = await withCwd(
      root,
      () =>
        Effect.runPromise(
          Effect.flatMap(AppPlanner, (planner) =>
            planner.plan(compiled, { ...TestRuntimeProvider.capabilities, artifactBuild: true }),
          ).pipe(Effect.provide(AppPlannerLayer.layer.pipe(Layer.provide(bundledCatalog)))),
        ),
      [root],
    );
    // Then the planner uses store verbatim, without a hidden app prefix.
    expect(lint.valid).toBe(true);
    for (const service of ["web", "worker"]) {
      expect(plan.services[ServiceName.make(service)]?.mounts).toContainEqual(
        expect.objectContaining({ type: "volume", store: `${slug}-${service}-data`, target: "/data" }),
      );
      expect(plan.services[ServiceName.make(service)]?.mounts).toContainEqual(
        expect.objectContaining({ type: "volume", store: `${slug}-shared`, target: "/shared" }),
      );
      expect(plan.services[ServiceName.make(service)]?.mounts).toContainEqual(
        expect.objectContaining({ type: "volume", store: "authored-volume", target: "/explicit" }),
      );
    }
    expect(plan.services[ServiceName.make("web")]?.mounts).toContainEqual(
      expect.objectContaining({ store: `${slug}-web-empty` }),
    );
    expect(plan.services[ServiceName.make("web")]?.mounts).toContainEqual(
      expect.objectContaining({ store: `${slug}-web-cache-data` }),
    );
    const tool = plan.services[ServiceName.make("tool")];
    expect(tool?.readiness).toBeUndefined();
    expect(tool?.environment).not.toHaveProperty("LANDO_APP_ROOT");
    expect(tool?.environment).not.toHaveProperty("LANDO_PROJECT_MOUNT");
    expect(tool?.mounts.filter(({ target }) => target === "/src")).toHaveLength(1);
    expect(tool?.mounts).toContainEqual(
      expect.objectContaining({ type: "bind", source: root, target: "/src" }),
    );
    expect(tool?.mounts.some(({ target }) => target === "/app")).toBe(false);
    expect(plan.services[ServiceName.make("bare")]?.mounts.some(({ target }) => target === "/app")).toBe(
      false,
    );
    expect(translated.diagnostics).toContainEqual(
      expect.objectContaining({ kind: "dropped", keyPath: ["services", "tool", "healthcheck"] }),
    );
    expect(
      translated.diagnostics.filter(({ message }) => message.startsWith("Unclaimed Lando 3 setting ")),
    ).toEqual([]);
  });
});
