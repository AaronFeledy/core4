import { Effect, Schema } from "effect";

import { PortablePath } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition } from "@lando/sdk/services";

export const LANDO_SECURITY_FEATURE_ID = "lando.security" as const;
export const LANDO_SECURITY_FEATURE_PRIORITY = 1100;

const CA_BUNDLE_PATH = "/etc/lando/certs/ca-bundle.pem" as const;
const CA_DIRECTORY_PATH = "/etc/lando/certs" as const;
const CA_TRUST_INPUT_DIRECTORY = "/usr/local/share/ca-certificates" as const;

const CaDescriptor = Schema.Struct({
  path: Schema.String,
  digest: Schema.String.pipe(
    Schema.pattern(/^[0-9a-f]{64}$/u, { message: () => "Expected a lowercase SHA-256 hex digest." }),
  ),
});

const ProxyConfig = Schema.Struct({
  http: Schema.optional(Schema.String),
  https: Schema.optional(Schema.String),
  noProxy: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
});

const LandoSecurityFeatureConfigSchema = Schema.Struct({
  injectCa: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  injectProxy: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  cas: Schema.optionalWith(Schema.Array(CaDescriptor), { default: () => [] }),
  bundlePath: Schema.optional(Schema.String),
  proxy: Schema.optional(ProxyConfig),
});
type LandoSecurityFeatureConfig = typeof LandoSecurityFeatureConfigSchema.Type;

const applyCaIntent = (ctx: ServiceFeatureContext, config: LandoSecurityFeatureConfig): void => {
  if (!config.injectCa || config.cas.length === 0) return;

  for (const ca of config.cas) {
    ctx.addMount({
      type: "bind",
      source: ca.path,
      target: PortablePath.make(`${CA_TRUST_INPUT_DIRECTORY}/lando-${ca.digest}.crt`),
      readOnly: true,
    });
  }
  if (config.bundlePath !== undefined) {
    ctx.addMount({
      type: "bind",
      source: config.bundlePath,
      target: PortablePath.make(CA_BUNDLE_PATH),
      readOnly: true,
    });
  }

  ctx.addEnv("NODE_EXTRA_CA_CERTS", CA_BUNDLE_PATH);
  ctx.addEnv("SSL_CERT_FILE", CA_BUNDLE_PATH);
  ctx.addEnv("SSL_CERT_DIR", CA_DIRECTORY_PATH);
  ctx.addEnv("LANDO_CA_CERT", CA_BUNDLE_PATH);
  ctx.addEnv("LANDO_CA_BUNDLE", CA_BUNDLE_PATH);
  ctx.addEnv("LANDO_CA_DIR", CA_DIRECTORY_PATH);
  ctx.addBuildStep({
    id: "lando.security:trust-store",
    phase: "build",
    command: ":",
    buildKeyInputs: { caDigests: config.cas.map((ca) => ca.digest).sort() },
  });
};

const applyProxyIntent = (ctx: ServiceFeatureContext, config: LandoSecurityFeatureConfig): void => {
  if (!config.injectProxy || config.proxy === undefined) return;

  if (config.proxy.http !== undefined) ctx.addEnv("HTTP_PROXY", config.proxy.http);
  if (config.proxy.https !== undefined) ctx.addEnv("HTTPS_PROXY", config.proxy.https);
  ctx.addEnv("NO_PROXY", config.proxy.noProxy.join(","));
};

export const landoSecurityFeature: ServiceFeatureDefinition = {
  id: LANDO_SECURITY_FEATURE_ID,
  schema: LandoSecurityFeatureConfigSchema as Schema.Schema<unknown>,
  priority: LANDO_SECURITY_FEATURE_PRIORITY,
  apply: (ctx) =>
    Effect.sync(() => {
      const config = ctx.config as LandoSecurityFeatureConfig;
      applyCaIntent(ctx, config);
      applyProxyIntent(ctx, config);
    }),
};
