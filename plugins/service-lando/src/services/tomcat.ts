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

const DEFAULT_PORT = Schema.decodeUnknownSync(PortNumber)(8080);
const TomcatFeatureConfig = Schema.Struct({ webroot: Schema.String, ownsImageConfig: Schema.Boolean });
type TomcatFeatureConfig = typeof TomcatFeatureConfig.Type;
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
  const { webroot, ownsImageConfig } = ctx.config as TomcatFeatureConfig;

  ctx.setArtifact({ kind: "ref", ref: service.image ?? ARTIFACTS["11"] });
  ctx.addEndpoint({
    _tag: "internal",
    port: Schema.decodeUnknownSync(PortNumber)(port),
    protocol: "http",
    name: ctx.serviceName,
  });
  ctx.setHealthcheck(loopbackTcpHealthcheck(port, 20));
  if (ownsImageConfig) {
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

const makeTomcatServiceType = (id: string, image: string): ServiceType => ({
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
          image: input.service.image ?? image,
          certs: input.service.certs ?? true,
        },
        features: [
          {
            id: TOMCAT_FEATURE_ID,
            config: {
              webroot,
              ownsImageConfig:
                !(input.service.build !== undefined && "context" in input.service.build) &&
                (input.service.image === undefined || input.service.image === image),
            },
          },
          { id: "lando.env", config: { webroot } },
          { id: "lando.app-mount", config: { target: "/app" } },
        ],
      };
    });
  },
});

export const tomcat9ServiceType = makeTomcatServiceType("tomcat:9", ARTIFACTS["9"]);
export const tomcat10ServiceType = makeTomcatServiceType("tomcat:10", ARTIFACTS["10"]);
export const tomcat11ServiceType = makeTomcatServiceType("tomcat:11", ARTIFACTS["11"]);
export const tomcatServiceType = makeTomcatServiceType("tomcat", ARTIFACTS["11"]);
