import { isPlainRecord, withValueOrigins } from "@lando/sdk/landofile";
import type { LandofileShape } from "@lando/sdk/schema";
import { copyLandofileProvenance } from "../copy-provenance.ts";
import { getOrigins, rememberOrigins } from "./origins.ts";
import type { AuthoredOrigin } from "./prepare.ts";

/** Runtime-owned identity and service selection, private to the root loader. */
export type LandofileFinalizeOverrides = Readonly<Pick<LandofileShape, "name" | "provider">> & {
  readonly excludedServices?: ReadonlyArray<string>;
};

export const applyFinalizeOverrides = (
  document: Record<string, unknown>,
  overrides: LandofileFinalizeOverrides | undefined,
): Record<string, unknown> => {
  if (overrides === undefined) return document;
  const { excludedServices = [], ...identity } = overrides;
  const excluded = new Set(excludedServices);
  const origin: AuthoredOrigin = { file: "<lando-identity>", layer: "canonical", path: [] };
  const origins = getOrigins(document) ?? withValueOrigins(document, (path) => ({ ...origin, path })).origins;
  const replacement = withValueOrigins(identity, (path) => ({ ...origin, path })).origins;
  const children = new Map([...origins.children, ...replacement.children]);
  const services = document.services;
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
  return rememberOrigins(
    copyLandofileProvenance(document, {
      ...document,
      ...identity,
      ...(isPlainRecord(services) ? { services: selected } : {}),
    }),
    {
      ...origins,
      children,
    },
  );
};
