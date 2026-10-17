import { Schema } from "effect";

import { PortNumber } from "@lando/sdk/schema";
import { TomcatServiceConfig } from "@lando/sdk/schema/services/tomcat";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
import {
  loopbackTcpHealthcheck,
  rootIdentity,
  serviceFeatureApply,
  serviceTypeResolve,
} from "./_feature-helpers.ts";

import { applyAuthoredProcessFields } from "./_process-helpers.ts";
import { resolveWebroot } from "./_webroot.ts";
import { TOMCAT_CATALOG } from "./generated/tomcat-catalog.ts";

const DEFAULT_PORT = Schema.decodeUnknownSync(PortNumber)(8080);
const TomcatFeatureConfig = Schema.Struct({
  webroot: Schema.String,
  ownsImageConfig: Schema.Boolean,
  major: Schema.Literals(["9", "10", "11"]),
});
const VERSIONS = ["9", "10", "11"] as const;
const ARTIFACTS = {
  "9": TOMCAT_CATALOG["9"].image,
  "10": TOMCAT_CATALOG["10"].image,
  "11": TOMCAT_CATALOG["11"].image,
} as const;

export const TOMCAT_FEATURE_ID = "service-lando.tomcat";

const applyTomcatFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const port = Schema.decodeUnknownSync(PortNumber)(service.port ?? DEFAULT_PORT);
  const { webroot, ownsImageConfig, major } = Schema.decodeUnknownSync(TomcatFeatureConfig)(ctx.config);

  ctx.setArtifact({ kind: "ref", ref: service.image ?? ARTIFACTS["11"] });
  ctx.addEndpoint({
    _tag: "internal",
    port,
    protocol: "http",
    name: ctx.serviceName,
  });
  ctx.setHealthcheck(loopbackTcpHealthcheck(port, 20));
  if (ownsImageConfig) {
    ctx.addBuildStep({
      id: "service-lando.tomcat:server-config",
      phase: "build",
      user: "root",
      command: [
        "sh",
        "-c",
        'set -eu; printf \'%s\' "$1" > "${CATALINA_HOME:-/usr/local/tomcat}/conf/server.xml"',
        "lando-tomcat-config",
        TOMCAT_CATALOG[major].serverXml.replace("{{HTTP_PORT}}", String(port)),
      ],
    });
    ctx.addBuildStep({
      id: "service-lando.tomcat:root-context",
      phase: "build",
      user: "root",
      command: [
        "sh",
        "-c",
        `set -eu; context_dir="\${CATALINA_HOME:-/usr/local/tomcat}/conf/Catalina/localhost"; mkdir -p "$context_dir"; printf '%s\\n' '<Context docBase="${webroot}"/>' > "$context_dir/ROOT.xml"`,
      ],
    });
  }

  applyAuthoredProcessFields(ctx);
};

export const tomcatServiceFeature: ServiceFeatureDefinition = {
  id: TOMCAT_FEATURE_ID,
  schema: TomcatFeatureConfig,
  priority: 600,
  apply: serviceFeatureApply(TOMCAT_FEATURE_ID, "tomcat service feature failed to apply", applyTomcatFeature),
};

const makeTomcatServiceType = (id: string, major: (typeof VERSIONS)[number]): ServiceType => ({
  id,
  name: "tomcat",
  base: "lando",
  versions: VERSIONS,
  artifacts: ARTIFACTS,
  identity: rootIdentity(),
  schema: TomcatServiceConfig,
  resolve: (input) => {
    return serviceTypeResolve(id, `Failed to resolve ${id}`, () => {
      const webroot = resolveWebroot("tomcat", input.service.webroot, input.service.appMount);
      return {
        base: "lando",
        normalizedConfig: {
          ...input.service,
          type: "tomcat",
          image: input.service.image ?? ARTIFACTS[major],
          certs: input.service.certs ?? true,
        },
        features: [
          {
            id: TOMCAT_FEATURE_ID,
            config: {
              webroot,
              major,
              ownsImageConfig:
                !(input.service.build !== undefined && "context" in input.service.build) &&
                (input.service.image === undefined || input.service.image === ARTIFACTS[major]),
            },
          },
          { id: "lando.env", config: { webroot } },
          { id: "lando.app-mount", config: { target: "/app" } },
        ],
      };
    });
  },
});

export const tomcat9ServiceType = makeTomcatServiceType("tomcat:9", "9");
export const tomcat10ServiceType = makeTomcatServiceType("tomcat:10", "10");
export const tomcat11ServiceType = makeTomcatServiceType("tomcat:11", "11");
export const tomcatServiceType = makeTomcatServiceType("tomcat", "11");
