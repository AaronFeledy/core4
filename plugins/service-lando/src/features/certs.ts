/**
 * Leaf material lives below `/etc/lando/certs/leaf` because `lando.security`
 * exposes `/etc/lando/certs` as an OpenSSL trusted-CA directory.
 *
 * Generated leaf files are written by apply, so their binds never let the
 * runtime create a missing source: a missing file fails instead of turning
 * into an empty directory inside the container.
 */

import { CertificateName, PortablePath } from "@lando/sdk/schema";
import type { ServiceFeatureDefinition } from "@lando/sdk/services";
import { Effect, Schema } from "effect";

const LANDO_CERTS_FEATURE_ID = "lando.certs" as const;
const LANDO_CERTS_FEATURE_PRIORITY = 1000;

const LEAF_CERT_DIRECTORY = "/etc/lando/certs/leaf" as const;

const leafFileName = (serviceName: string): string => encodeURIComponent(serviceName).replaceAll(".", "%2E");

const LandoCertsFeatureConfigSchema = Schema.Struct({
  certPath: Schema.optionalKey(Schema.String),
  keyPath: Schema.optionalKey(Schema.String),
  cn: Schema.optionalKey(CertificateName),
  sans: Schema.Array(CertificateName).pipe(Schema.withDecodingDefaultKey(Effect.sync(() => []))),
  caId: Schema.optionalKey(Schema.String),
}).pipe(
  Schema.check(
    Schema.makeFilter((config) => config.keyPath === undefined || config.certPath !== undefined, {
      message: "lando.certs keyPath requires certPath.",
    }),
  ),
);
type LandoCertsFeatureConfig = typeof LandoCertsFeatureConfigSchema.Type;

export const landoCertsFeature: ServiceFeatureDefinition = {
  id: LANDO_CERTS_FEATURE_ID,
  schema: LandoCertsFeatureConfigSchema as Schema.Codec<unknown>,
  priority: LANDO_CERTS_FEATURE_PRIORITY,
  apply: (ctx) =>
    Effect.sync(() => {
      const config = ctx.config as LandoCertsFeatureConfig;
      const serviceFileName = leafFileName(ctx.serviceName);
      const generated = config.cn !== undefined && config.caId !== undefined;

      if (config.certPath !== undefined) {
        const target = `${LEAF_CERT_DIRECTORY}/${serviceFileName}.crt`;
        ctx.addMount({
          type: "bind",
          source: config.certPath,
          target: PortablePath.make(target),
          readOnly: true,
          ...(generated ? { createHostPath: false } : {}),
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
          ...(generated ? { createHostPath: false } : {}),
        });
        ctx.addEnv("LANDO_SERVICE_KEY", target);
      }

      if (generated) {
        ctx.setCerts({ cn: config.cn, sans: config.sans, caId: config.caId });
      } else if (config.certPath !== undefined) {
        ctx.addExtension("@lando/core/certs", "custom");
      } else {
        ctx.addExtension("@lando/core/certs", "none");
      }
    }),
};
