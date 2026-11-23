import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { LandofileShape, ServiceName, bindSyncIgnores, serviceAppMount } from "@lando/sdk/schema";
import { AppPlanner, PathsService } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Schema } from "effect";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import * as AppPlannerLayer from "../../src/services/planner.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";

const planAt = (root: string, services: typeof LandofileShape.Encoded.services) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({ name: "app-mounts", runtime: 4, services });
  const planner = AppPlannerLayer.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        PluginRegistryLayer.layer,
        BunFileSystem.layer,
        Layer.succeed(PathsService, makeLandoPaths({ platform: "linux", home: root, env: {} })),
      ),
    ),
  );
  return Effect.runPromise(
    Effect.flatMap(AppPlanner, (service) =>
      service.plan(literalTestLandofile(landofile, root), TestRuntimeProvider.capabilities),
    ).pipe(Effect.provide(planner)),
  );
};

test.each([
  { label: "default PnP", shadow: false },
  { label: "node-modules linker", rc: "nodeLinker: node-modules", shadow: true },
  { label: "authored exclude in PnP", excludes: ["node_modules"], shadow: true },
  {
    label: "authored include and exclude in PnP",
    excludes: ["node_modules"],
    includes: ["node_modules"],
    shadow: false,
  },
  {
    label: "authored include with node-modules",
    rc: "nodeLinker: node-modules",
    includes: ["node_modules"],
    shadow: false,
  },
])("plans the node_modules shadow and sync ignore for $label", async ({ rc, excludes, includes, shadow }) => {
  const root = await mkdtemp(join(tmpdir(), "lando-yarn-mounts-"));
  try {
    await writeFile(join(root, "package.json"), '{"packageManager":"yarn@4.5.3"}');
    if (rc !== undefined) await writeFile(join(root, ".yarnrc.yml"), rc);
    const plan = await planAt(root, {
      web: {
        type: "node:22",
        ...(excludes === undefined && includes === undefined
          ? {}
          : { appMount: { target: "/app", excludes: excludes ?? [], includes: includes ?? [] } }),
      },
    });

    const web = plan.services[ServiceName.make("web")];
    if (web === undefined) throw new Error("Expected the planned web service");
    const bind = serviceAppMount(web);
    if (bind === undefined) throw new Error("Expected the web app mount");
    expect(web.mounts.some((mount) => mount.type === "volume" && mount.target === "/app/node_modules")).toBe(
      shadow,
    );
    expect(bindSyncIgnores(web, bind).includes("node_modules")).toBe(shadow);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plans only the app-mount shadows declared by each service type", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-type-mounts-"));
  try {
    await mkdir(join(root, "apps/web"), { recursive: true });
    await writeFile(join(root, "apps/web/package.json"), '{"packageManager":"npm@11.0.0"}');
    await writeFile(join(root, "package.json"), '{"packageManager":"yarn@4.5.3"}');

    const plan = await planAt(root, {
      web: { type: "node:22", packageRoot: "apps/web" },
      pnp: { type: "node:22" },
      byo: { type: "node:22", image: "node:22-alpine" },
      ruby: { type: "ruby:3.3" },
      php: { type: "php:8.2" },
      raw: { type: "compose", image: "alpine", appMount: { target: "/app" } },
    });

    expect(
      Object.fromEntries(
        Object.entries(plan.services).map(([name, service]) => [
          name,
          service.mounts
            .filter((mount) => mount.type === "volume" && mount.target.startsWith("/app/"))
            .map((mount) => String(mount.target))
            .sort(),
        ]),
      ),
    ).toEqual({
      web: ["/app/apps/web/node_modules", "/app/node_modules"],
      pnp: [],
      byo: ["/app/node_modules"],
      ruby: ["/app/.bundle", "/app/vendor/bundle"],
      php: [],
      raw: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
