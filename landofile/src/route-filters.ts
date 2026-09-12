/**
 * Route-filter array identity for Landofile overlay merge, and attach.
 *
 * Named entries match only by `name`. Unnamed entries fall back to `type`.
 * A named entry never matches an unnamed entry.
 */

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type RouteFilterIdentity =
  | { readonly kind: "name"; readonly value: unknown }
  | { readonly kind: "type"; readonly value: unknown };

export const routeFilterIdentity = (item: unknown): RouteFilterIdentity | undefined => {
  if (!isPlainRecord(item)) return undefined;
  if (Object.hasOwn(item, "name")) {
    const { name } = item;
    return { kind: "name", value: name };
  }
  if (Object.hasOwn(item, "type")) {
    const { type } = item;
    return { kind: "type", value: type };
  }
  return undefined;
};

export const routeFilterMatches = (candidate: unknown, item: unknown): boolean => {
  const left = routeFilterIdentity(candidate);
  const right = routeFilterIdentity(item);
  return left !== undefined && right !== undefined && left.kind === right.kind && left.value === right.value;
};

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
