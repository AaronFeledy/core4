import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSyncResolver } from "@lando/engine/plugins/file-sync-resolver";
import * as PluginRegistryLayer from "@lando/engine/plugins/registry";
import * as BunFileSystem from "@lando/engine/services/file-system";
import * as AppPlannerLayer from "@lando/engine/services/planner";
import { loadAuthoredDocuments } from "@lando/landofile/root-compile";
import { makeLandoPaths } from "@lando/paths";
import {
  PortablePath,
  ServiceName,
  type ServicePlan,
  landoAppStoreName,
  serviceAppMount,
} from "@lando/sdk/schema";
import { AppPlanner, PathsService } from "@lando/sdk/services";
import { TestFileSyncEngine, TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer } from "effect";
import { previewBuiltinRecipe } from "../_support/recipe-output.ts";

const MOUNT_TARGET = "/app/web/modules/custom/example";

const planContribApp = async (name: string, answers: Readonly<Record<string, string>> = {}, slow = false) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), `lando-drupal-contrib-${name}-`)));
  try {
    const preview = await previewBuiltinRecipe("drupal-contrib", name, { project: "example", ...answers });
    const compiled = await Effect.runPromise(
      loadAuthoredDocuments([{ file: join(root, ".lando.yml"), value: Bun.YAML.parse(preview.text) }], {
        appRoot: root,
        file: join(root, ".lando.yml"),
      }),
    );
    const planner = AppPlannerLayer.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          PluginRegistryLayer.layer,
          FileSyncResolver.layerWithEngine(TestFileSyncEngine, { platform: ["linux"] }),
          BunFileSystem.layer,
          Layer.succeed(PathsService, makeLandoPaths({ platform: "linux", home: root, env: {} })),
        ),
      ),
    );
    return await Effect.runPromise(
      Effect.flatMap(AppPlanner, (service) =>
        service.plan(compiled, {
          ...TestRuntimeProvider.capabilities,
          bindMountPerformance: slow ? "slow" : "native",
          fileSyncTargets: "prepared-volume",
        }),
      ).pipe(Effect.provide(planner)),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const service = (
  plan: { readonly services: Readonly<Record<string, ServicePlan | undefined>> },
  name: string,
) => {
  const planned = plan.services[ServiceName.make(name)];
  if (planned === undefined) throw new Error(`Expected Drupal contrib ${name}`);
  return planned;
};

/** The site volume at /app and the nested checkout bind, with no vendor, node_modules, or tmp shadows. */
const expectSiteLayout = (planned: ServicePlan, store: string, readOnly: boolean) => {
  const site = planned.mounts.find((mount) => mount.type === "volume" && mount.target === "/app");
  expect(site).toMatchObject({ type: "volume", store, readOnly });
  const appMount = serviceAppMount(planned);
  expect(appMount?.target).toBe(PortablePath.make(MOUNT_TARGET));
  expect(appMount?.includes ?? []).toEqual([]);
  expect(appMount?.excludes ?? []).not.toContain("vendor");
  for (const shadow of ["vendor", "node_modules", "tmp"] as const) {
    expect(
      planned.mounts.some((mount) => mount.type === "volume" && mount.target === `${MOUNT_TARGET}/${shadow}`),
    ).toBe(false);
  }
};

test.each([{ slow: false }, { slow: true }])(
  "plans one app-scoped site volume per app around the nested checkout when %j",
  async ({ slow }) => {
    const stores: string[] = [];
    for (const name of ["contrib-alpha", "contrib-beta"]) {
      const label = `${name}-${slow ? "slow" : "native"}`;
      const plan = await planContribApp(label, {}, slow);
      const store = landoAppStoreName(label, "site");
      expectSiteLayout(service(plan, "appserver"), store, false);
      expect(plan.stores.find((entry) => entry.name === store)?.scope).toBe("app");
      stores.push(store);
    }
    expect(stores[0]).not.toBe(stores[1]);
  },
);

test.each([{ slow: false }, { slow: true }])(
  "serves the scaffolded site from the nginx edge through the same volume, read-only when %j",
  async ({ slow }) => {
    const label = `contrib-nginx-${slow ? "slow" : "native"}`;
    const plan = await planContribApp(label, { webserver: "nginx" }, slow);
    const store = landoAppStoreName(label, "site");
    expectSiteLayout(service(plan, "appserver"), store, false);
    expectSiteLayout(service(plan, "edge"), store, true);
  },
);
