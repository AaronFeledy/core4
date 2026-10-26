import { withValueOrigins } from "@lando/sdk/landofile";
import type { LandofileShape } from "@lando/sdk/schema";
import { copyLandofileProvenance } from "../copy-provenance.ts";
import { getOrigins, rememberOrigins } from "./origins.ts";
import type { AuthoredOrigin } from "./prepare.ts";

/** Runtime-owned identity, private to the root loader rather than the SDK contract. */
export type LandofileFinalizeOverrides = Readonly<Pick<LandofileShape, "name" | "provider">>;

export const applyFinalizeOverrides = (
  document: Record<string, unknown>,
  overrides: LandofileFinalizeOverrides | undefined,
): Record<string, unknown> => {
  if (overrides === undefined) return document;
  const origin: AuthoredOrigin = { file: "<lando-identity>", layer: "canonical", path: [] };
  const origins = getOrigins(document) ?? withValueOrigins(document, (path) => ({ ...origin, path })).origins;
  const replacement = withValueOrigins(overrides, (path) => ({ ...origin, path })).origins;
  return rememberOrigins(copyLandofileProvenance(document, { ...document, ...overrides }), {
    ...origins,
    children: new Map([...origins.children, ...replacement.children]),
  });
};
