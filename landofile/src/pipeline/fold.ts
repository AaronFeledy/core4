import {
  type ValueWithOrigins,
  isPlainRecord,
  mergeValuesWithOrigins,
  withValueOrigins,
} from "@lando/sdk/landofile";
import { LandofileShape } from "@lando/sdk/schema";
import type { AuthoredOrigin } from "../provenance.ts";
import { composeToolingIncludeEntries } from "../tooling-include-entries.ts";

/**
 * Only the empty fold root needs a generated origin; overlays retain their authored origins.
 */
export const foldAuthoredOverlays = (
  overlays: readonly ValueWithOrigins<AuthoredOrigin>[],
  fallback: AuthoredOrigin,
): ValueWithOrigins<AuthoredOrigin> => {
  let merged = withValueOrigins<AuthoredOrigin>({}, () => fallback);
  for (const value of overlays) merged = mergeValuesWithOrigins(LandofileShape, merged, value);
  const tooling = composeToolingIncludeEntries(overlays);
  const children = new Map(merged.origins.children);
  if (tooling.length > 0) {
    children.set("includes", {
      source: children.get("includes")?.source ?? fallback,
      deleted: false,
      children: new Map(tooling.map((entry, index) => [index, entry.origins] as const)),
    });
  }
  return {
    value: {
      ...(isPlainRecord(merged.value) ? merged.value : {}),
      ...(tooling.length === 0 ? {} : { includes: tooling.map((entry) => entry.value) }),
    },
    origins: { ...merged.origins, children },
  };
};
