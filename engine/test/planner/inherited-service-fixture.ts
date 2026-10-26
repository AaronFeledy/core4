import {
  AppPlanner,
  PluginRegistry,
  type ServiceType,
  type ServiceTypeResolution,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Schema } from "effect";
import * as Registry from "../../src/plugins/registry.ts";
import { composeExtendedServiceType } from "../../src/services/extends.ts";
import * as Planner from "../../src/services/planner.ts";
import { compileTestLandofile } from "../compiled-landofile.ts";

export const inheritedServiceRegistry = (
  parentId: string,
  contribution: Partial<ServiceTypeResolution> = {},
  factory?: ServiceType["toolingForConnection"],
) =>
  Layer.effect(
    PluginRegistry,
    Effect.gen(function* () {
      const registry = yield* PluginRegistry;
      const parent = yield* registry.loadServiceType(parentId);
      const child: ServiceType = {
        id: `derived-${parentId}`,
        name: `derived-${parentId}`,
        base: parent.base,
        extends: parent.id,
        schema: Schema.Unknown,
        ...(factory === undefined ? {} : { toolingForConnection: factory }),
        resolve: () =>
          Effect.succeed({ base: parent.base, normalizedConfig: {}, features: [], ...contribution }),
      };
      const composed = yield* composeExtendedServiceType(child, (id) =>
        id === parent.id ? parent : undefined,
      );
      return PluginRegistry.of({
        ...registry,
        loadServiceType: (id) => (id === child.id ? Effect.succeed(composed) : registry.loadServiceType(id)),
      });
    }),
  ).pipe(Layer.provide(Registry.layerWith({ user: false, app: false })));

export const planInherited = (
  parent: string,
  options: Readonly<Record<string, unknown>>,
  withConsumer = false,
) =>
  Effect.gen(function* () {
    const landofile = yield* compileTestLandofile({
      name: "inherited-creds",
      services: {
        ...(withConsumer
          ? {
              web: {
                type: "lando",
                image: "alpine:3",
                home: false,
                environment: { PASSWORD: "{{ services.database.creds.password }}" },
              },
            }
          : {}),
        database: { type: `derived-${parent}`, ...options },
      },
    });
    const planner = yield* AppPlanner;
    const registry = yield* PluginRegistry;
    const plan = yield* planner.plan(landofile, TestRuntimeProvider.capabilities);
    const serviceType = yield* registry.loadServiceType(`derived-${parent}`);
    return { plan, serviceType };
  }).pipe(Effect.provide(Planner.layer), Effect.provide(inheritedServiceRegistry(parent)));
