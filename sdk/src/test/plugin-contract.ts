import { Effect, Either, Layer, Schema } from "effect";

import { PluginLoadError, PluginManifestError } from "../errors/index.ts";
import { PluginManifest } from "../schema/index.ts";
import type { ServiceType } from "../services/index.ts";
import { ContractFailure, isNonEmptyString } from "./_shared.ts";

type PluginLayerExportName =
  | "ca"
  | "engine"
  | "logger"
  | "provider"
  | "proxy"
  | "renderer"
  | "services"
  | "templateEngine";

export interface PluginContractInput {
  readonly manifest: unknown;
  readonly layers?: Partial<Record<PluginLayerExportName, Layer.Layer<never, unknown, unknown>>>;
  readonly globalServices?: ReadonlyMap<string, Effect.Effect<unknown, unknown, never>>;
  readonly serviceTypes?: ReadonlyMap<string, ServiceType>;
  readonly templateEngines?: ReadonlyMap<string, unknown>;
}

const pluginContributionLayerExports: ReadonlyArray<{
  readonly key: keyof NonNullable<PluginManifest["contributes"]>;
  readonly exportName: PluginLayerExportName;
}> = [
  { key: "cas", exportName: "ca" },
  { key: "fileSyncEngines", exportName: "engine" },
  { key: "loggers", exportName: "logger" },
  { key: "providers", exportName: "provider" },
  { key: "proxies", exportName: "proxy" },
  { key: "renderers", exportName: "renderer" },
  { key: "serviceTypes", exportName: "services" },
  { key: "templateEngines", exportName: "templateEngine" },
];

export const TestPluginManifest: PluginManifest = Schema.decodeSync(PluginManifest)({
  name: "@lando/test-plugin",
  version: "0.0.0",
  api: 4,
  description: "SDK plugin contract fixture.",
  enabled: true,
  contributes: { loggers: ["test"] },
  entry: "./src/index.ts",
  requires: { "@lando/core": "^4.0.0" },
});

const pluginContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({
    message: `Plugin contract failed: ${assertion}`,
    assertion,
    details,
  });

const requirePluginContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(pluginContractFailure(assertion, details));

const isLayer = (value: unknown): boolean => Layer.isLayer(value);

const hasNonEmptyContributionEntries = (values: ReadonlyArray<unknown> | undefined): boolean =>
  values === undefined ||
  values.every(
    (value) =>
      isNonEmptyString(value) ||
      (typeof value === "object" && value !== null && "id" in value && isNonEmptyString(value.id)),
  );

const contributionId = (value: string | { readonly id: string }): string =>
  typeof value === "string" ? value : value.id;

const REQUIRED_CORE_RANGE = "^4.0.0";

const CORE_COMPATIBILITY_ASSERTION = 'manifest requires "@lando/core" "^4.0.0"';

const CORE_COMPATIBILITY_REMEDIATION = 'Set requires["@lando/core"] to "^4.0.0".';

type CoreRequirementClassification = "compatible" | "missing" | "overly-broad" | "incompatible";

const classifyCoreRequirement = (requires: PluginManifest["requires"]): CoreRequirementClassification => {
  const raw = requires?.["@lando/core"];
  if (typeof raw !== "string" || raw.trim() === "") return "missing";

  const range = raw.trim();
  if (range === REQUIRED_CORE_RANGE) return "compatible";

  if (
    /^[xX*](?:\.[xX*]){0,2}$/.test(range) ||
    range.includes("||") ||
    /^>=\s*(?:0|4(?:\.0(?:\.0)?)?)$/.test(range) ||
    /^>\s*4(?:\.0(?:\.0)?)?$/.test(range)
  ) {
    return "overly-broad";
  }

  return "incompatible";
};

export const runPluginContract = (input: PluginContractInput): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const decodedManifest = Schema.decodeUnknownEither(PluginManifest)(input.manifest, {
      onExcessProperty: "error",
    });

    yield* requirePluginContract(
      Either.isRight(decodedManifest),
      "manifest decodes as PluginManifest",
      decodedManifest,
    );
    if (Either.isLeft(decodedManifest)) return;

    const manifest = decodedManifest.right;

    yield* requirePluginContract(
      isNonEmptyString(manifest.name),
      "manifest name is a non-empty string",
      manifest,
    );
    yield* requirePluginContract(
      isNonEmptyString(manifest.version),
      "manifest version is a non-empty string",
      manifest,
    );
    yield* requirePluginContract(manifest.api === 4, "manifest api is 4", manifest);

    const coreCompatibility = classifyCoreRequirement(manifest.requires);
    yield* requirePluginContract(coreCompatibility === "compatible", CORE_COMPATIBILITY_ASSERTION, {
      reason: coreCompatibility,
      declared: manifest.requires?.["@lando/core"],
      remediation: CORE_COMPATIBILITY_REMEDIATION,
    });

    const contributions = manifest.contributes ?? {};

    for (const [key, values] of Object.entries(contributions)) {
      if (Array.isArray(values) && key !== "globalServices") {
        yield* requirePluginContract(
          hasNonEmptyContributionEntries(values),
          `contribution ${key} contains only non-empty ids`,
          values,
        );
      }
    }

    for (const { key, exportName } of pluginContributionLayerExports) {
      const ids = contributions[key];
      if (!Array.isArray(ids) || ids.length === 0) continue;

      yield* requirePluginContract(
        isLayer(input.layers?.[exportName]),
        `contribution ${key} exposes Layer export ${exportName}`,
        { exportName, ids },
      );
    }

    for (const entry of contributions.globalServices ?? []) {
      yield* requirePluginContract(
        isNonEmptyString(entry.id),
        "globalServices entries have non-empty ids",
        entry,
      );
      yield* requirePluginContract(
        Effect.isEffect(input.globalServices?.get(entry.id)),
        `globalServices static map contains declared id ${entry.id}`,
        entry,
      );
    }

    for (const entry of contributions.serviceTypes ?? []) {
      const id = contributionId(entry);
      yield* requirePluginContract(
        input.serviceTypes?.has(id) === true,
        `serviceTypes static map contains declared id ${id}`,
        { id },
      );
    }

    for (const entry of contributions.templateEngines ?? []) {
      const id = contributionId(entry);
      yield* requirePluginContract(
        input.templateEngines?.has(id) === true,
        `templateEngines static map contains declared id ${id}`,
        { id },
      );
    }

    const loadError = new PluginLoadError({
      message: "plugin contract load error",
      pluginName: manifest.name,
    });
    const manifestError = new PluginManifestError({
      message: "plugin contract manifest error",
      pluginName: manifest.name,
      issues: ["contract"],
    });

    yield* requirePluginContract(
      loadError._tag === "PluginLoadError",
      "PluginLoadError tag is constructible",
      loadError,
    );
    yield* requirePluginContract(
      manifestError._tag === "PluginManifestError",
      "PluginManifestError tag is constructible",
      manifestError,
    );
  });
