import { isPlainRecord, withValueOrigins } from "@lando/sdk/landofile";
import type { LandofileShape } from "@lando/sdk/schema";
import type { AuthoredDocument, AuthoredOrigin } from "../provenance.ts";

/** Runtime-owned identity and service selection, private to the root loader. */
export type LandofileFinalizeOverrides = Readonly<Pick<LandofileShape, "name" | "provider">> & {
  readonly excludedServices?: ReadonlyArray<string>;
};

export const applyFinalizeOverrides = (
  document: AuthoredDocument,
  overrides: LandofileFinalizeOverrides | undefined,
): AuthoredDocument => {
  if (overrides === undefined) return document;
  const { excludedServices = [], ...identity } = overrides;
  const excluded = new Set(excludedServices);
  // Generated values: runtime-owned identity and service selection name their own
  // `<lando-identity>` origin instead of borrowing an authored file.
  const origin: AuthoredOrigin = { file: "<lando-identity>", layer: "canonical", path: [] };
  const origins = document.provenance.origins;
  const replacement = withValueOrigins(identity, (path) => ({ ...origin, path })).origins;
  const children = new Map([...origins.children, ...replacement.children]);
  const services = document.value.services;
  const selected = isPlainRecord(services)
    ? Object.fromEntries(Object.entries(services).filter(([id]) => !excluded.has(id)))
    : services;
  const serviceOrigins = children.get("services");
  if (serviceOrigins !== undefined && isPlainRecord(services)) {
    children.set("services", {
      ...serviceOrigins,
      children: new Map([...serviceOrigins.children].filter(([id]) => !excluded.has(String(id)))),
    });
  }
  return {
    value: {
      ...document.value,
      ...identity,
      ...(isPlainRecord(services) ? { services: selected } : {}),
    },
    provenance: { ...document.provenance, origins: { ...origins, children } },
  };
};
