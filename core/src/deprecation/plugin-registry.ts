import { Effect, Layer } from "effect";

import {
  type ContributionRef,
  type DeprecationNotice,
  JSON_SCHEMA_NAMES,
  type PluginManifest,
  getJsonSchema,
  schemaDeprecationsFromJsonSchema,
} from "@lando/sdk/schema";
import { DeprecationService, PluginRegistry } from "@lando/sdk/services";
import {
  SETUP_BUILTIN_FLAG_NAMES,
  findSetupFlagCollision,
  manifestSetupFlagContributions,
} from "../plugins/setup-flags.ts";
import { registerBuiltInContractDeprecations } from "./built-in-contracts.ts";

type ContributionKind =
  | "serviceTypes"
  | "serviceFeatures"
  | "providers"
  | "loggers"
  | "renderers"
  | "templateEngines"
  | "fileSyncEngines"
  | "cas"
  | "commands";

const CONTRIBUTION_KIND_TO_DEPRECATION_KIND = {
  serviceTypes: "service-type",
  serviceFeatures: "service-feature",
  providers: "provider-extension",
  loggers: "manifest-contribution",
  renderers: "render-event",
  templateEngines: "manifest-contribution",
  fileSyncEngines: "manifest-contribution",
  cas: "manifest-contribution",
  commands: "command",
} as const;

const CONTRIBUTION_KINDS: ReadonlyArray<ContributionKind> = [
  "serviceTypes",
  "serviceFeatures",
  "providers",
  "loggers",
  "renderers",
  "templateEngines",
  "fileSyncEngines",
  "cas",
  "commands",
];

const contributionId = (entry: ContributionRef): string => (typeof entry === "string" ? entry : entry.id);

const contributionNotice = (entry: ContributionRef): DeprecationNotice | undefined =>
  typeof entry === "string" ? undefined : entry.deprecated;

const registerPluginDeprecations = (manifests: ReadonlyArray<PluginManifest>) =>
  Effect.gen(function* () {
    const deprecations = yield* DeprecationService;
    for (const manifest of manifests) {
      if (manifest.deprecated !== undefined) {
        yield* deprecations.register("plugin", "plugin", manifest.name, manifest.deprecated);
      }
      for (const kind of CONTRIBUTION_KINDS) {
        const entries = manifest.contributes?.[kind] ?? [];
        for (const entry of entries) {
          const notice = contributionNotice(entry);
          if (notice !== undefined) {
            yield* deprecations.register(
              "plugin",
              CONTRIBUTION_KIND_TO_DEPRECATION_KIND[kind],
              contributionId(entry),
              notice,
            );
          }
        }
      }
      for (const service of manifest.contributes?.globalServices ?? []) {
        if (service.deprecated !== undefined) {
          yield* deprecations.register(
            "plugin",
            "manifest-contribution",
            `${manifest.name}:globalServices.${service.id}`,
            service.deprecated,
          );
        }
      }
      for (const proxy of manifest.contributes?.proxyServices ?? []) {
        if (proxy.deprecated !== undefined) {
          yield* deprecations.register(
            "plugin",
            "provider-extension",
            `${manifest.name}:proxyServices.${proxy.id}`,
            proxy.deprecated,
          );
        }
      }
      for (const flag of manifest.contributes?.setup?.flags ?? []) {
        if (flag.deprecated !== undefined) {
          yield* deprecations.register(
            "plugin",
            "flag",
            `${manifest.name}:setup.${flag.name}`,
            flag.deprecated,
          );
        }
      }
    }
  });

const registerSchemaDeprecations = Effect.gen(function* () {
  const deprecations = yield* DeprecationService;
  for (const schemaName of JSON_SCHEMA_NAMES) {
    for (const entry of schemaDeprecationsFromJsonSchema(getJsonSchema(schemaName))) {
      yield* deprecations.register("schema-walk", "schema-field", `${schemaName}${entry.path}`, entry.notice);
    }
  }
});

export const DeprecationPluginRegistryLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const plugins = yield* PluginRegistry;
    const manifests = yield* plugins.list.pipe(Effect.catchAll(() => Effect.succeed([])));
    const deprecations = yield* DeprecationService;
    const collision = findSetupFlagCollision(
      SETUP_BUILTIN_FLAG_NAMES,
      manifestSetupFlagContributions(manifests),
    );
    if (collision !== undefined) yield* Effect.fail(collision);
    yield* registerSchemaDeprecations;
    yield* registerBuiltInContractDeprecations(deprecations);
    yield* registerPluginDeprecations(manifests);
  }),
);
