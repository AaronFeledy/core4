import { Effect, Schema } from "effect";

import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

import {
  ServiceConfigIssue,
  addEnvRecord,
  rootIdentity,
  serviceFeatureApply,
  serviceFeatureValidateEffective,
  serviceTypeResolve,
} from "./_feature-helpers.ts";
import {
  type ListenerContract,
  assertListenerConfig,
  listenerAuthority,
  plannedPort,
  servicePortEndpoints,
} from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";
import { resolveWebroot } from "./_webroot.ts";

export interface LanguageFrameworkPreset extends ListenerContract {
  readonly env?: ReadonlyMap<string, string>;
  readonly webroot?: string;
}

interface LanguageFeatureConfig<V extends string, F extends string> {
  readonly framework: F;
  readonly version: V;
  readonly port: number;
  readonly webroot?: string;
}

interface LanguageRuntimeSpec<V extends string, F extends string> {
  readonly language: string;
  readonly displayName: string;
  readonly versions: readonly V[];
  readonly artifacts: Readonly<Record<string, string>>;
  readonly artifactFor: (version: V) => string;
  readonly frameworks: readonly F[];
  readonly presets: Readonly<Record<F, LanguageFrameworkPreset>>;
  readonly baseEnv: Readonly<Record<string, string>>;
  readonly mountExcludes: readonly string[];
  readonly includeWebrootInFeatureConfig: boolean;
  readonly extensionKey: string;
  readonly featureId: string;
  readonly priority: number;
  readonly featureSchema: Schema.Codec<unknown>;
  readonly configFor: (ctx: { readonly config: Readonly<Record<string, unknown>> }) => LanguageFeatureConfig<
    V,
    F
  >;
  readonly applyFallback: string;
  readonly resolveFallback: (version: V) => string;
}

export const APP_MOUNT_TARGET = "/app";
const DEFAULT_KEEP_ALIVE = ["tail", "-f", "/dev/null"] as const;

export const makeLanguageRuntime = <V extends string, F extends string>(spec: LanguageRuntimeSpec<V, F>) => {
  const validateFramework = (raw: string | undefined): F => {
    const framework = spec.frameworks.find((candidate) => candidate === (raw ?? "none"));
    if (framework !== undefined) return framework;
    throw new ServiceConfigIssue(
      ["framework"],
      `Unsupported ${spec.displayName} framework "${raw}".`,
      `Set framework to one of: ${spec.frameworks.join(", ")} (got ${raw}).`,
    );
  };

  const validateVersion = (declaredType: string | undefined, fallback: V): V => {
    const prefix = `${spec.language}:`;
    if (declaredType === undefined || !declaredType.startsWith(prefix)) return fallback;
    const requested = declaredType.slice(prefix.length);
    const version = spec.versions.find((candidate) => candidate === requested);
    if (version !== undefined) return version;
    throw new ServiceConfigIssue(
      ["type"],
      `Unsupported ${spec.displayName} version "${requested}".`,
      `Set type to one of: ${spec.versions.map((v) => `${prefix}${v}`).join(", ")} (got ${prefix}${requested}).`,
    );
  };

  const applyFeature = (ctx: ServiceFeatureContext): void => {
    const service = ctx.normalizedConfig;
    const { framework, version, port, webroot } = spec.configFor(ctx);
    ctx.setArtifact({ kind: "ref", ref: service.image ?? spec.artifactFor(version) });
    const env = { ...spec.baseEnv };
    for (const [key, value] of spec.presets[framework].env ?? []) env[key] = value;
    for (const variable of spec.presets[framework].variables ?? []) env[variable] = String(port);
    addEnvRecord(ctx, env);
    ctx.setListenerAuthority(listenerAuthority(spec.presets[framework], "application", port));
    ctx.setCommand(service.command ?? [...DEFAULT_KEEP_ALIVE]);
    applyAuthoredProcessFields(ctx, ["user"]);
    applyAuthoredProcessFields(ctx, ["entrypoint"]);
    ctx.addExtension(spec.extensionKey, {
      framework,
      version,
      port,
      ...(service.appMount === false || webroot === undefined ? {} : { webroot }),
    });
  };

  const serviceFeature: ServiceFeatureDefinition = {
    id: spec.featureId,
    schema: spec.featureSchema,
    priority: spec.priority,
    validateEffective: serviceFeatureValidateEffective(spec.featureId, (ctx) => {
      const { framework, port, webroot } = spec.configFor(ctx);
      assertListenerConfig(ctx.normalizedConfig, { ...spec.presets[framework], port });
      return {
        handledServiceFields:
          spec.includeWebrootInFeatureConfig &&
          ctx.normalizedConfig.appMount !== false &&
          webroot !== undefined
            ? ["webroot"]
            : [],
      };
    }),
    declareEndpoints: (ctx) =>
      Effect.sync(() => {
        const { port } = spec.configFor(ctx);
        return servicePortEndpoints(ctx, { port, protocol: "http" });
      }),
    apply: serviceFeatureApply(spec.featureId, spec.applyFallback, applyFeature),
  };

  const makeServiceType = (version: V): ServiceType => ({
    id: `${spec.language}:${version}`,
    name: `${spec.language}:${version}`,
    base: "lando",
    versions: spec.versions,
    artifacts: spec.artifacts,
    identity: rootIdentity(),
    schema: Schema.Unknown,
    resolve: (input) =>
      serviceTypeResolve(`${spec.language}:${version}`, spec.resolveFallback(version), () => {
        const resolvedVersion = validateVersion(input.service.type, version);
        const framework = validateFramework(input.service.framework);
        const preset = spec.presets[framework];
        const endpointPort = plannedPort(input.service, preset);
        const webroot =
          spec.includeWebrootInFeatureConfig && input.service.appMount !== false
            ? {
                webroot: resolveWebroot(
                  spec.displayName,
                  input.service.webroot ?? preset.webroot,
                  input.service.appMount,
                ),
              }
            : {};
        return {
          base: "lando" as const,
          normalizedConfig: { ...input.service, type: `${spec.language}:${resolvedVersion}` },
          features: [
            {
              id: spec.featureId,
              config: {
                framework,
                version: resolvedVersion,
                port: endpointPort,
                ...webroot,
              },
            },
            { id: "lando.env", config: webroot },
            {
              id: "lando.app-mount",
              config: {
                target: APP_MOUNT_TARGET,
                excludes: spec.mountExcludes,
              },
            },
          ],
        };
      }),
  });

  return { validateVersion, validateFramework, applyFeature, serviceFeature, makeServiceType };
};
