import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { LandofileShape, type ProviderCapabilities, ServiceName } from "@lando/core/schema";
import { AppPlanner } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { PluginRegistryLive } from "../../src/testing/engine-layers.ts";
import { AppPlannerLive } from "../../src/testing/engine-layers.ts";

const composeServiceFieldCapabilities: ProviderCapabilities = {
  ...TestRuntimeProvider.capabilities,
  composeKnobs: {
    supported: [...(TestRuntimeProvider.capabilities.composeKnobs?.supported ?? []), "shm_size"],
  },
  composeServiceFields: {
    supported: ["networks", "configs", "secrets", "profiles", "labels"],
  },
};

const withTempCwd = async <A>(run: () => Promise<A>): Promise<A> => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "lando-compose-service-fields-")));
  const previousCwd = process.cwd();
  try {
    process.chdir(directory);
    return await run();
  } finally {
    process.chdir(previousCwd);
    await rm(directory, { recursive: true, force: true });
  }
};

const plan = (landofile: typeof LandofileShape.Type) =>
  Effect.runPromise(
    Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, composeServiceFieldCapabilities)).pipe(
      Effect.provide(AppPlannerLive),
      Effect.provide(PluginRegistryLive),
    ),
  );

describe("Compose service field preservation", () => {
  test("Given all service fields and labels, when planning, then canonical vendor values and prior labels survive", async () => {
    // Given
    const nestedExtension = {
      nested: {
        list: [1, "two", { enabled: true }],
        scalar: null,
      },
    } as const;
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "compose-fields",
      runtime: 4,
      services: {
        web: {
          image: "node:lts",
          labels: { "io.lando.role": "web" },
          networks: ["frontend"],
          configs: [
            "app-config",
            {
              source: "site-config",
              target: "/etc/site.conf",
              uid: "1000",
              gid: "1000",
              mode: 288,
              "x-config": { strategy: "copy" },
            },
          ],
          secrets: ["api-token"],
          profiles: ["dev"],
          "x-foo": nestedExtension,
        },
      },
    });

    await withTempCwd(async () => {
      // When
      const appPlan = await plan(landofile);
      const compose = appPlan.services[ServiceName.make("web")]?.extensions.compose;

      // Then
      const expectedCompose = {
        labels: { "io.lando.role": "web" },
        networks: { frontend: {} },
        configs: [
          { source: "app-config" },
          {
            source: "site-config",
            target: "/etc/site.conf",
            uid: "1000",
            gid: "1000",
            mode: 288,
            "x-config": { strategy: "copy" },
          },
        ],
        secrets: [{ source: "api-token" }],
        profiles: ["dev"],
        "x-foo": nestedExtension,
      };
      expect(compose).toEqual(expectedCompose);
      expect(JSON.stringify(compose)).toBe(JSON.stringify(expectedCompose));
    });
  });

  test("Given a service carrying only an x-prefixed extension, when planning, then the extension is preserved", async () => {
    // Given
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "x-only",
      runtime: 4,
      services: {
        web: {
          image: "node:lts",
          "x-foo": { enabled: true },
        },
      },
    });

    await withTempCwd(async () => {
      // When
      const appPlan = await plan(landofile);

      // Then
      expect(appPlan.services[ServiceName.make("web")]?.extensions.compose).toEqual({
        "x-foo": { enabled: true },
      });
    });
  });

  test("Given a runtime knob and a service field, when planning, then the knob merge preserves the service field", async () => {
    // Given
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "knob-and-field",
      runtime: 4,
      services: {
        web: {
          image: "node:lts",
          profiles: ["dev"],
          shm_size: "64m",
        },
      },
    });

    await withTempCwd(async () => {
      // When
      const appPlan = await plan(landofile);

      // Then
      expect(appPlan.services[ServiceName.make("web")]?.extensions.compose).toEqual({
        profiles: ["dev"],
        shm_size: 67_108_864,
      });
    });
  });
});
