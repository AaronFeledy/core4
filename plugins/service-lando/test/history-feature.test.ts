import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";

import {
  GlobalConfig,
  HISTORY_FEATURE_ID,
  HISTORY_MOUNT_TARGET,
  LandofileShape,
  PortablePath,
  ServiceConfig,
  ServiceName,
  historyStoreName,
} from "@lando/sdk/schema";
import { AppPlanner, ConfigService } from "@lando/sdk/services";
import { TestRuntimeProvider, runAppFeatureContract } from "@lando/sdk/test";

import * as PluginRegistryLayer from "@lando/engine/plugins/registry";
import * as AppPlannerLayer from "@lando/engine/services/planner";

import { historyVolumeFeature } from "../src/app-features/history.ts";
import { LANDO_BOOT_FEATURE_ID } from "../src/features/boot.ts";

const planApp = (landofile: typeof LandofileShape.Type, config?: GlobalConfig) => {
  const planner = AppPlannerLayer.layer.pipe(
    Layer.provide(
      config === undefined
        ? PluginRegistryLayer.layer
        : Layer.mergeAll(
            PluginRegistryLayer.layer,
            Layer.succeed(
              ConfigService,
              ConfigService.of({
                load: Effect.succeed(config),
                get: <K extends keyof GlobalConfig>(key: K) => Effect.succeed(config[key]),
              }),
            ),
          ),
    ),
  );
  return Effect.runPromise(
    Effect.flatMap(AppPlanner, (service) => service.plan(landofile, TestRuntimeProvider.capabilities)).pipe(
      Effect.provide(planner),
    ),
  );
};

describe("service-lando.history AppFeature", () => {
  test("declares empty activatedBy.services and omits selectors", () => {
    expect(historyVolumeFeature.id).toBe(HISTORY_FEATURE_ID);
    expect(historyVolumeFeature.activatedBy).toEqual({ services: {} });
    expect(historyVolumeFeature.selectors).toBeUndefined();
  });

  test("satisfies runAppFeatureContract", async () => {
    await expect(
      Effect.runPromise(
        runAppFeatureContract({
          feature: historyVolumeFeature,
          services: [
            {
              serviceName: "appserver",
              serviceType: "php:8.3",
              base: "lando",
              featureIds: [LANDO_BOOT_FEATURE_ID],
            },
            {
              serviceName: "nginx",
              serviceType: "nginx",
              base: "lando",
              featureIds: [LANDO_BOOT_FEATURE_ID],
            },
          ],
        }),
      ),
    ).resolves.toBeUndefined();
  });

  test("mounts one app-scoped history volume on default types", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "histapp",
      services: {
        appserver: { type: "php:8.3", home: false },
        database: { type: "mysql", home: false },
      },
    });
    const plan = await planApp(landofile);
    const store = historyStoreName("histapp");
    expect(plan.stores).toEqual(expect.arrayContaining([{ name: store, scope: "app", kind: "data" }]));
    expect(plan.stores.filter((entry) => entry.name === store)).toHaveLength(1);
    expect(plan.services[ServiceName.make("appserver")]?.storage).toEqual(
      expect.arrayContaining([{ store, target: PortablePath.make(HISTORY_MOUNT_TARGET), readOnly: false }]),
    );
    expect(plan.services[ServiceName.make("database")]?.storage).toEqual(
      expect.arrayContaining([{ store, target: PortablePath.make(HISTORY_MOUNT_TARGET), readOnly: false }]),
    );
  });

  test("honors history: false and history: true", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "histopt",
      services: {
        appserver: { type: "php:8.3", home: false, history: false },
        nginx: { type: "nginx", home: false, history: true },
      },
    });
    const plan = await planApp(landofile);
    const store = historyStoreName("histopt");
    expect(plan.services[ServiceName.make("appserver")]?.storage.some((mount) => mount.store === store)).toBe(
      false,
    );
    expect(plan.services[ServiceName.make("nginx")]?.storage).toEqual(
      expect.arrayContaining([{ store, target: PortablePath.make(HISTORY_MOUNT_TARGET), readOnly: false }]),
    );
  });

  test("does not empty-match-fail an nginx-only app", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "nginxonly",
      services: { nginx: { type: "nginx", home: false } },
    });
    const plan = await planApp(landofile);
    expect(plan.stores.some((store) => store.name === historyStoreName("nginxonly"))).toBe(false);
  });

  test("does not throw for an app with only non-compose services", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "cacheonly",
      services: { cache: { type: "memcached", home: false } },
    });
    const plan = await planApp(landofile);
    expect(plan.stores.some((store) => store.name === historyStoreName("cacheonly"))).toBe(false);
    expect(
      plan.services[ServiceName.make("cache")]?.storage.some(
        (mount) => mount.target === PortablePath.make(HISTORY_MOUNT_TARGET),
      ),
    ).toBe(false);
  });

  test("honors history: true on a non-compose service", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "cachehist",
      services: { cache: { type: "memcached", home: false, history: true } },
    });
    const plan = await planApp(landofile);
    const store = historyStoreName("cachehist");
    expect(plan.stores).toEqual(expect.arrayContaining([{ name: store, scope: "app", kind: "data" }]));
    expect(plan.services[ServiceName.make("cache")]?.storage).toEqual(
      expect.arrayContaining([{ store, target: PortablePath.make(HISTORY_MOUNT_TARGET), readOnly: false }]),
    );
  });

  test("honors global history.enabled false", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "histoff",
      services: {
        appserver: { type: "php:8.3", home: false },
        nginx: { type: "nginx", home: false, history: true },
      },
    });
    const plan = await planApp(
      landofile,
      Schema.decodeUnknownSync(GlobalConfig)({ history: { enabled: false } }),
    );
    expect(plan.stores.some((store) => store.name === historyStoreName("histoff"))).toBe(false);
    expect(
      Object.values(plan.services).some((service) =>
        service.storage.some((mount) => mount.target === HISTORY_MOUNT_TARGET),
      ),
    ).toBe(false);
  });
});

test("ServiceConfig decodes history true and false", () => {
  expect(Schema.decodeUnknownSync(ServiceConfig)({ history: true }).history).toBe(true);
  expect(Schema.decodeUnknownSync(ServiceConfig)({ history: false }).history).toBe(false);
  expect(
    Schema.decodeUnknownSync(ServiceConfig)(Schema.decodeUnknownSync(ServiceConfig)({ history: false }))
      .history,
  ).toBe(false);
});
