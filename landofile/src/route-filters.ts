/**
 * Attach a route filter, replacing an entry with the same identity.
 *
 * Named entries match only by `name`. Unnamed entries fall back to `type`.
 * A named entry never matches an unnamed entry.
 */

import { routeFilterMatches } from "@lando/sdk/landofile";

export const attachRouteFilter = <R extends { readonly filters?: ReadonlyArray<unknown> }>(
  route: R,
  filter: unknown,
): R & { readonly filters: ReadonlyArray<unknown> } => {
  const current = route.filters ?? [];
  const existingIndex = current.findIndex((candidate) => routeFilterMatches(candidate, filter));
  const filters =
    existingIndex === -1
      ? [...current, filter]
      : current.map((candidate, index) => (index === existingIndex ? filter : candidate));
  return { ...route, filters };
};
