import { Effect, Schema } from "effect";

import { AbsolutePath, PortNumber, PortablePath } from "@lando/sdk/schema";
import { TomcatServiceConfig } from "@lando/sdk/schema/services/tomcat";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
import { serviceFeatureApply } from "./_feature-helpers.ts";

import { appNameFor } from "../app-name.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";

const DEFAULT_PORT = Schema.decodeUnknownSync(PortNumber)(8080);
const DEFAULT_WEBROOT = PortablePath.make("/usr/local/tomcat/webapps/ROOT");
const VERSIONS = ["9", "10", "11"] as const;
const ARTIFACTS = {
  "9": "tomcat:9-jre21",
  "10": "tomcat:10-jre21",
  "11": "tomcat:11-jre21",
} as const;

export const TOMCAT_FEATURE_ID = "service-lando.tomcat";

const applyTomcatFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const port = service.port ?? DEFAULT_PORT;
  const webroot = service.webroot ?? DEFAULT_WEBROOT;
  const passthrough = { realization: "passthrough" as const };

  ctx.setArtifact({ kind: "ref", ref: service.image ?? ARTIFACTS["11"] });
  ctx.setAppMount({
    source: AbsolutePath.make(ctx.appRoot),
    target: webroot,
    readOnly: false,
    excludes: [],
    includes: [],
    ...passthrough,
  });
  ctx.addMount({
    type: "bind",
    source: ctx.appRoot,
    target: webroot,
    readOnly: false,
    ...passthrough,
  });
  ctx.addEndpoint({
    _tag: "internal",
    port: Schema.decodeUnknownSync(PortNumber)(port),
    protocol: "http",
    name: ctx.serviceName,
  });
  ctx.setHealthcheck({
    kind: "command",
    command: ["bash", "-c", `exec 3<>/dev/tcp/127.0.0.1/${port}`],
    intervalSeconds: 10,
    timeoutSeconds: 5,
    retries: 5,
    startPeriodSeconds: 20,
  });

  applyAuthoredProcessFields(ctx);
};

export const tomcatServiceFeature: ServiceFeatureDefinition = {
  id: TOMCAT_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  apply: serviceFeatureApply(TOMCAT_FEATURE_ID, "tomcat service feature failed to apply", applyTomcatFeature),
};

const makeTomcatServiceType = (id: string, image: string): ServiceType => ({
  id,
  name: "tomcat",
  base: "lando",
  versions: VERSIONS,
  artifacts: ARTIFACTS,
  identity: { defaultUser: "root", homes: { root: "/root" } },
  schema: TomcatServiceConfig,
  resolve: (input) => {
    const appName = appNameFor(input);
    return Effect.succeed({
      base: "lando",
      normalizedConfig: {
        ...input.service,
        type: "tomcat",
        image: input.service.image ?? image,
        webroot: input.service.webroot ?? DEFAULT_WEBROOT,
        certs: input.service.certs ?? true,
        routes: input.service.routes ?? [
          { hostname: `${input.name}.${appName}.lndo.site`, endpoint: input.service.port ?? DEFAULT_PORT },
        ],
      },
      features: [{ id: TOMCAT_FEATURE_ID }],
    });
  },
});

export const tomcat9ServiceType = makeTomcatServiceType("tomcat:9", ARTIFACTS["9"]);
export const tomcat10ServiceType = makeTomcatServiceType("tomcat:10", ARTIFACTS["10"]);
export const tomcat11ServiceType = makeTomcatServiceType("tomcat:11", ARTIFACTS["11"]);
export const tomcatServiceType = makeTomcatServiceType("tomcat", ARTIFACTS["11"]);
