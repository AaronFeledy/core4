import { CertificatePlan, HostAliasName, HostAliasPlan, certificateNameForHostname } from "@lando/sdk/schema";
import { Option, Predicate, Schema } from "effect";

const HistoricalAlias = Schema.Struct({ ...HostAliasPlan.fields, hostname: Schema.String });
const HistoricalCertificate = Schema.Struct({
  ...CertificatePlan.fields,
  cn: Schema.String,
  sans: Schema.Array(Schema.String),
});

/** Repair only historical name fields; the caller decodes the complete plan afterwards. */
export const migrateAppliedNames = (raw: unknown): unknown | null => {
  if (!Predicate.isObject(raw) || !Predicate.isObject(raw.services)) return null;
  const services: Record<string, unknown> = {};
  for (const [name, service] of Object.entries(raw.services)) {
    if (!Predicate.isObject(service)) return null;
    const aliases = Schema.decodeUnknownOption(Schema.Array(HistoricalAlias))(service.hostAliases);
    if (Option.isNone(aliases)) return null;
    let certs = service.certs;
    if (certs !== undefined) {
      const historical = Schema.decodeUnknownOption(HistoricalCertificate)(certs);
      if (Option.isNone(historical)) return null;
      const cn = certificateNameForHostname(historical.value.cn);
      if (cn === undefined) return null;
      const sans = historical.value.sans.flatMap((hostname) => {
        const mapped = certificateNameForHostname(hostname);
        return mapped === undefined ? [] : [mapped];
      });
      certs = { ...historical.value, cn, sans: [...new Set(sans)] };
    }
    services[name] = {
      ...service,
      hostAliases: aliases.value.filter((alias) => Schema.is(HostAliasName)(alias.hostname)),
      ...(certs === undefined ? {} : { certs }),
    };
  }
  return { ...raw, services };
};
