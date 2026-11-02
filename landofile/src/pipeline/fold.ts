import { isPlainRecord, mergeValuesWithOrigins, withValueOrigins } from "@lando/sdk/landofile";
import { LandofileShape } from "@lando/sdk/schema";
import { composeToolingIncludeEntries } from "../tooling-include-entries.ts";
import { getOrigins, rememberOrigins } from "./origins.ts";
import type { AuthoredOrigin } from "./prepare.ts";

export const foldAuthoredOverlays = (
  overlays: readonly Record<string, unknown>[],
  fallback: AuthoredOrigin,
): Record<string, unknown> => {
  let merged = withValueOrigins<AuthoredOrigin>({}, () => fallback);
  for (const value of overlays) {
    const origins = getOrigins(value) ?? withValueOrigins(value, (path) => ({ ...fallback, path })).origins;
    merged = mergeValuesWithOrigins(LandofileShape, merged, { value, origins });
  }
  const tooling = composeToolingIncludeEntries(overlays);
  const children = new Map(merged.origins.children);
  if (tooling.length > 0) {
    children.set("includes", {
      source: children.get("includes")?.source ?? fallback,
      deleted: false,
      children: new Map(
        tooling.flatMap((entry, index) =>
          entry.origins === undefined ? [] : [[index, entry.origins] as const],
        ),
      ),
    });
  }
  return rememberOrigins(
    {
      ...(isPlainRecord(merged.value) ? merged.value : {}),
      ...(tooling.length === 0 ? {} : { includes: tooling.map((entry) => entry.value) }),
    },
    { ...merged.origins, children },
  );
};
