import { Schema } from "effect";

import { PortablePath } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

import {
  addEnvRecord,
  loopbackTcpHealthcheck,
  rootIdentity,
  serviceFeatureApply,
  serviceTypeResolve,
} from "./_feature-helpers.ts";
import { addServicePortEndpoints } from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";
import { mountAppRoot } from "./_volume-helpers.ts";

export interface LanguageFrameworkPreset {
  readonly port: number;
  readonly defaultCommand: ReadonlyArray<string> | null;
  readonly env?: ReadonlyMap<string, string>;
  readonly webroot?: string;
}

interface LanguageFeatureConfig<V extends string, F extends string> {
  readonly framework: F;
  readonly version: V;
  readonly port: number;
  readonly defaultCommand?: ReadonlyArray<string> | null;
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
  readonly mountRealization?: "passthrough";
  readonly includeWebrootInFeatureConfig: boolean;
  readonly extensionKey: string;
  readonly featureId: string;
  readonly priority: number;
  readonly featureSchema: Schema.Codec<unknown>;
  readonly configFor: (ctx: ServiceFeatureContext) => LanguageFeatureConfig<V, F>;
  readonly applyFallback: string;
  readonly resolveFallback: (version: V) => string;
}

const APP_MOUNT_TARGET = PortablePath.make("/app");
const DEFAULT_KEEP_ALIVE = ["sh", "-c", "tail -f /dev/null"] as const;

export const makeLanguageRuntime = <V extends string, F extends string>(spec: LanguageRuntimeSpec<V, F>) => {
  const validateFramework = (raw: string | undefined): F => {
    const framework = spec.frameworks.find((candidate) => candidate === (raw ?? "none"));
    if (framework !== undefined) return framework;
    throw new Error(
      `Unsupported ${spec.displayName} framework "${raw}". Set framework to one of: ${spec.frameworks.join(", ")} (got ${raw}).`,
    );
  };

  const validateVersion = (declaredType: string | undefined, fallback: V): V => {
    const prefix = `${spec.language}:`;
    if (declaredType === undefined || !declaredType.startsWith(prefix)) return fallback;
    const requested = declaredType.slice(prefix.length);
    const version = spec.versions.find((candidate) => candidate === requested);
    if (version !== undefined) return version;
    throw new Error(
      `Unsupported ${spec.displayName} version "${requested}". Set type to one of: ${spec.versions.map((v) => `${prefix}${v}`).join(", ")} (got ${prefix}${requested}).`,
    );
  };

  const applyFeature = (ctx: ServiceFeatureContext): void => {
    const service = ctx.normalizedConfig;
    const { framework, version, port, webroot, defaultCommand } = spec.configFor(ctx);
    ctx.setArtifact({ kind: "ref", ref: service.image ?? spec.artifactFor(version) });
    const env = { ...spec.baseEnv };
    for (const [key, value] of spec.presets[framework].env ?? []) env[key] = value;
    addEnvRecord(ctx, env);
    ctx.setCommand(service.command ?? [...DEFAULT_KEEP_ALIVE]);
    ctx.setWorkingDirectory(service.workingDirectory ?? APP_MOUNT_TARGET);
    applyAuthoredProcessFields(ctx, ["user"]);
    mountAppRoot(ctx, {
      excludes: spec.mountExcludes,
      ...(spec.mountRealization === undefined ? {} : { realization: spec.mountRealization }),
    });
    addServicePortEndpoints(ctx, { port, protocol: "http" });
    ctx.setHealthcheck(loopbackTcpHealthcheck(port, 10));
    applyAuthoredProcessFields(ctx, ["entrypoint"]);
    ctx.addExtension(spec.extensionKey, {
      framework,
      version,
      defaultCommand: defaultCommand ?? null,
      port,
      ...(spec.includeWebrootInFeatureConfig ? { webroot } : {}),
    });
  };

  const serviceFeature: ServiceFeatureDefinition = {
    id: spec.featureId,
    schema: spec.featureSchema,
    priority: spec.priority,
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
        const endpointPort = input.service.port ?? preset.port;
        const webroot = spec.includeWebrootInFeatureConfig ? { webroot: preset.webroot } : {};
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
                defaultCommand: preset.defaultCommand,
              },
            },
            { id: "lando.env", config: { appPaths: { appRoot: "/app", projectMount: "/app" }, ...webroot } },
          ],
        };
      }),
  });

  return { validateVersion, validateFramework, applyFeature, serviceFeature, makeServiceType };
};
