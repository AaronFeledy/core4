import { layer as plannerLayer } from "@lando/engine/services/planner";
import { PluginLoadError } from "@lando/sdk/errors";
import { type ProviderCapabilities, ProviderId, ServiceName } from "@lando/sdk/schema";
import { AppPlanner, PluginRegistry, type ServiceType } from "@lando/sdk/services";
import { Effect, Layer, Schema } from "effect";

export const hostProbeService = ServiceName.make("probe");
export const authoredExtraHosts = {
  "HOST.LANDO.INTERNAL": ["192.0.2.99", "2001:db8::99"],
  "custom.internal": ["192.0.2.10", "192.0.2.11", "2001:db8::10", "2001:db8::11"],
};

const serviceType: ServiceType = {
  id: "host-probe",
  name: "Host TCP probe",
  base: "l337",
  schema: Schema.Unknown,
  resolve: (input) =>
    Effect.succeed({ base: "l337", normalizedConfig: input.service, features: [{ id: "probe.image" }] }),
};
const unsupported = (id: string) =>
  Effect.fail(new PluginLoadError({ pluginName: id, message: `Unexpected plugin ${id}` }));
const registry = Layer.succeed(
  PluginRegistry,
  PluginRegistry.of({
    list: Effect.succeed([]),
    load: unsupported,
    loadServiceType: () => Effect.succeed(serviceType),
    loadServiceFeature: () =>
      Effect.succeed({
        id: "probe.image",
        priority: 100,
        // The fixture supplies only an image and command. The real planner owns
        // authored Compose-knob contribution and capability validation.
        apply: (ctx) =>
          Effect.sync(() => {
            ctx.setArtifact({ kind: "ref", ref: "node:22-alpine" });
            ctx.setCommand(["node", "-e", "setInterval(() => {}, 1000)"]);
          }),
      }),
    loadAppFeature: unsupported,
  }),
);

export const planHostProbe = (name: string, capabilities: ProviderCapabilities) =>
  Effect.flatMap(AppPlanner, (planner) =>
    planner.plan(
      {
        name,
        runtime: 4,
        provider: ProviderId.make("docker"),
        services: {
          [hostProbeService]: {
            type: serviceType.id,
            home: false,
            appMount: false,
            extra_hosts: authoredExtraHosts,
          },
        },
      },
      capabilities,
    ),
  ).pipe(Effect.provide(plannerLayer), Effect.provide(registry));
