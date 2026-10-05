import { Effect, Schema } from "effect";

import { ServiceTypeError } from "@lando/sdk/errors";
import { PortNumber, PortablePath, ServiceName, parseShortVolume } from "@lando/sdk/schema";
import { VarnishServiceConfig } from "@lando/sdk/schema/services/varnish";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
import { commandHealthcheck, rootIdentity, serviceFeatureApply } from "./_feature-helpers.ts";

import { appNameFor } from "../app-name.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";
import { resolveBindSource } from "./_volume-helpers.ts";

const DEFAULT_PORT = Schema.decodeUnknownSync(PortNumber)(80);
const DEFAULT_BACKEND_PORT = "80";
const VCL_TARGET = "/etc/varnish/default.vcl";
const GENERATED_VCL_PATH = "/tmp/lando-backend.vcl";
const VERSIONS = ["6", "7"] as const;
const ARTIFACTS = {
  "6": "varnish:6",
  "7": "varnish:7",
} as const;

export const VARNISH_FEATURE_ID = "service-lando.varnish";
export const VARNISH_VCL_TARGET = VCL_TARGET;

const vclOverrideBindSource = (
  service: ServiceFeatureContext["normalizedConfig"],
  appRoot: string,
): string | undefined => {
  for (const mount of service.mounts ?? []) {
    if (typeof mount === "string") {
      const parsed = parseShortVolume(mount);
      if (parsed.target === VCL_TARGET && parsed.source !== undefined) {
        return resolveBindSource(parsed.source, appRoot);
      }
      continue;
    }
    if (mount.target === VCL_TARGET && mount.source !== undefined) {
      return resolveBindSource(mount.source, appRoot);
    }
  }
  return undefined;
};

const varnishdCommand = (vclFile: string, listenPort: number): string =>
  `exec varnishd -F -f ${vclFile} -a :${String(listenPort)} -T localhost:6082 -s malloc,\${VARNISH_SIZE:-64m} -j none`;

const generatedVclCommand = (listenPort: number): string =>
  `printf 'vcl 4.0;\\nbackend default { .host = "%s"; .port = "%s"; }\\n' "$VARNISH_BACKEND_HOST" "$VARNISH_BACKEND_PORT" > ${GENERATED_VCL_PATH} && ${varnishdCommand(GENERATED_VCL_PATH, listenPort)}`;

const applyVarnishFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const port = service.port ?? DEFAULT_PORT;
  const backend = service.backend ?? "";

  ctx.setArtifact({ kind: "ref", ref: service.image ?? ARTIFACTS["7"] });
  ctx.addEnv("VARNISH_BACKEND_HOST", backend);
  ctx.addEnv("VARNISH_BACKEND_PORT", service.environment?.VARNISH_BACKEND_PORT ?? DEFAULT_BACKEND_PORT);
  ctx.addEndpoint({
    _tag: "internal",
    port: Schema.decodeUnknownSync(PortNumber)(port),
    protocol: "http",
    name: ctx.serviceName,
  });
  ctx.setHealthcheck(commandHealthcheck(["varnishadm", "ping"], 5));
  if (backend.length > 0) {
    ctx.addDependency({
      service: ServiceName.make(backend),
      condition: "service_healthy",
      required: true,
    });
  }

  applyAuthoredProcessFields(ctx, ["command", "entrypoint", "workingDirectory"]);
  // Official varnish images run as a non-root USER; varnishd also jails away from root.
  // Root plus `-j none` is required to bind :80 under rootless Podman.
  ctx.setUser(service.user ?? "root");

  const vclSource = vclOverrideBindSource(service, ctx.appRoot);
  if (vclSource !== undefined) {
    ctx.addMount({
      type: "bind",
      source: vclSource,
      target: PortablePath.make(VCL_TARGET),
      readOnly: true,
    });
  }

  if (service.command === undefined && service.entrypoint === undefined) {
    ctx.setEntrypoint(["/bin/sh", "-c"]);
    if (vclSource === undefined) {
      ctx.addEnv("VARNISH_VCL_FILE", GENERATED_VCL_PATH);
      ctx.setCommand([generatedVclCommand(port)]);
    } else {
      ctx.setCommand([varnishdCommand(VCL_TARGET, port)]);
    }
  }
};

export const varnishServiceFeature: ServiceFeatureDefinition = {
  id: VARNISH_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  apply: serviceFeatureApply(
    VARNISH_FEATURE_ID,
    "varnish service feature failed to apply",
    applyVarnishFeature,
  ),
};

const makeVarnishServiceType = (id: string, image: string): ServiceType => ({
  id,
  name: "varnish",
  base: "lando",
  versions: VERSIONS,
  artifacts: ARTIFACTS,
  identity: rootIdentity(),
  schema: VarnishServiceConfig,
  resolve: (input) => {
    const backend = input.service.backend?.trim() ?? "";
    if (backend.length === 0) {
      return Effect.fail(
        new ServiceTypeError({
          message: `Service ${input.name} requires backend: <service> naming an app service to cache. Add backend: pointing at an existing service in this Landofile.`,
          serviceType: id,
        }),
      );
    }

    const appName = appNameFor(input);
    return Effect.succeed({
      base: "lando",
      normalizedConfig: {
        ...input.service,
        type: "varnish",
        image: input.service.image ?? image,
        backend,
        certs: input.service.certs ?? true,
        routes: input.service.routes ?? [
          { hostname: `${input.name}.${appName}.lndo.site`, endpoint: input.service.port ?? DEFAULT_PORT },
        ],
      },
      features: [{ id: VARNISH_FEATURE_ID }],
    });
  },
});

export const varnish6ServiceType = makeVarnishServiceType("varnish:6", ARTIFACTS["6"]);
export const varnish7ServiceType = makeVarnishServiceType("varnish:7", ARTIFACTS["7"]);
export const varnishServiceType = makeVarnishServiceType("varnish", ARTIFACTS["7"]);
