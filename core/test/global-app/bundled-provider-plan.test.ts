import { describe, expect, test } from "bun:test";
import "../../src/runtime/engine-composition.ts";
import { Effect, Schema } from "effect";

import * as PluginRegistryLayer from "@lando/engine/plugins/registry";
import { HostProviderOverride } from "@lando/engine/providers/host-provider";
import { bundledFirstGlobalServiceLoader } from "@lando/engine/services/bundled-global-service-loader";
import { materializeGlobalServices } from "@lando/engine/services/global-services";
import * as AppPlannerLayer from "@lando/engine/services/planner";
import { loadAuthoredDocuments } from "@lando/landofile/root-compile";
import { dockerCapabilitiesForPlatform } from "@lando/provider-docker";
import { providerLandoCapabilitiesForPlatform } from "@lando/provider-lando";
import { podmanCapabilitiesForPlatform } from "@lando/provider-podman";
import {
  type HostPlatform,
  LandofileShape,
  type ProviderCapabilities,
  ProviderId,
  ServiceName,
} from "@lando/sdk/schema";
import { AppPlanner, PluginRegistry } from "@lando/sdk/services";

const bundledProviders: ReadonlyArray<readonly [string, (platform: HostPlatform) => ProviderCapabilities]> = [
  ["lando", (platform) => providerLandoCapabilitiesForPlatform(platform)],
  ["docker", dockerCapabilitiesForPlatform],
  ["podman", (platform) => podmanCapabilitiesForPlatform(platform)],
];
const platforms: ReadonlyArray<HostPlatform> = ["linux", "darwin", "win32"];
const cases = bundledProviders.flatMap(([id, capabilitiesFor]) =>
  platforms.map((platform) => [id, platform, capabilitiesFor(platform)] as const),
);

// The global app follows the host provider, so every bundled global service must plan on every bundled provider.
describe("bundled global services on bundled providers", () => {
  test.each(cases)(
    "plan every contributed global service on %s (%s)",
    async (id, _platform, capabilities) => {
      // Given
      const providerId = ProviderId.make(id);
      const program = Effect.gen(function* () {
        const manifests = yield* (yield* PluginRegistry).list;
        const services = yield* materializeGlobalServices({
          manifests,
          providerCapabilities: capabilities,
          providerId,
          loadServiceConfig: bundledFirstGlobalServiceLoader.load,
        });
        const landofile = Schema.decodeUnknownSync(LandofileShape)({
          name: "global",
          runtime: 4,
          provider: providerId,
          services,
        });
        const contributed = manifests.flatMap(
          (manifest) => manifest.contributes?.globalServices?.map((service) => service.id) ?? [],
        );
        // When
        const root = process.cwd();
        const compiled = yield* loadAuthoredDocuments(
          [{ file: `${root}/.lando.yml`, value: Schema.encodeSync(LandofileShape)(landofile) }],
          { appRoot: root, file: `${root}/.lando.yml` },
        );
        const plan = yield* (yield* AppPlanner).plan(compiled, capabilities);
        return { contributed, planned: Object.keys(plan.services), plan };
      }).pipe(
        // The global app is always planned on the host provider.
        Effect.provideService(HostProviderOverride, providerId),
        Effect.provide(AppPlannerLayer.layer),
        Effect.provide(PluginRegistryLayer.layer),
      );

      const { contributed, planned, plan } = await Effect.runPromise(program);

      // Then
      expect(contributed).toEqual(
        expect.arrayContaining(["traefik", "traefik-diagnostics", "ssh-agent", "mailpit"]),
      );
      expect([...planned].sort()).toEqual([...contributed].sort());
      expect(plan.networking?.perAppBridge).toBeNull();
      expect(plan.networks).toEqual([]);
      expect(plan.networking?.sharedNetworkMembership?.name).toBe("lando_bridge_network");
      for (const name of planned) {
        expect(plan.networking?.sharedNetworkMembership?.aliases[ServiceName.make(name)]).toContain(
          `${name}.global.internal`,
        );
      }
    },
  );
});
