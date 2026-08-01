/**
 * Leaf material lives below `/etc/lando/certs/leaf` because `lando.security`
 * exposes `/etc/lando/certs` as an OpenSSL trusted-CA directory.
 */
import { Effect, Schema } from "effect";

import { PortablePath } from "@lando/sdk/schema";
import type { ServiceFeatureDefinition } from "@lando/sdk/services";

const LANDO_CERTS_FEATURE_ID = "lando.certs" as const;
const LANDO_CERTS_FEATURE_PRIORITY = 1000;

const LEAF_CERT_DIRECTORY = "/etc/lando/certs/leaf" as const;

const leafFileName = (serviceName: string): string => encodeURIComponent(serviceName).replaceAll(".", "%2E");

const LandoCertsFeatureConfigSchema = Schema.Struct({
  certPath: Schema.optional(Schema.String),
  keyPath: Schema.optional(Schema.String),
  cn: Schema.optional(Schema.String),
  sans: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
  caId: Schema.optional(Schema.String),
}).pipe(
  Schema.filter((config) => config.keyPath === undefined || config.certPath !== undefined, {
    message: () => "lando.certs keyPath requires certPath.",
  }),
);
type LandoCertsFeatureConfig = typeof LandoCertsFeatureConfigSchema.Type;

export const landoCertsFeature: ServiceFeatureDefinition = {
  id: LANDO_CERTS_FEATURE_ID,
  schema: LandoCertsFeatureConfigSchema as Schema.Schema<unknown>,
  priority: LANDO_CERTS_FEATURE_PRIORITY,
  apply: (ctx) =>
    Effect.sync(() => {
      const config = ctx.config as LandoCertsFeatureConfig;
      const serviceFileName = leafFileName(ctx.serviceName);

      if (config.certPath !== undefined) {
        const target = `${LEAF_CERT_DIRECTORY}/${serviceFileName}.crt`;
        ctx.addMount({
          type: "bind",
          source: config.certPath,
          target: PortablePath.make(target),
          readOnly: true,
        });
        ctx.addEnv("LANDO_SERVICE_CERT", target);
      }

      if (config.keyPath !== undefined) {
        const target = `${LEAF_CERT_DIRECTORY}/${serviceFileName}.key`;
        ctx.addMount({
          type: "bind",
          source: config.keyPath,
          target: PortablePath.make(target),
          readOnly: true,
        });
        ctx.addEnv("LANDO_SERVICE_KEY", target);
      }

      if (config.cn !== undefined && config.caId !== undefined) {
        ctx.setCerts({ cn: config.cn, sans: config.sans, caId: config.caId });
      }
    }),
};
