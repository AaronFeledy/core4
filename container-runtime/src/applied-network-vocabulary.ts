import { isPlainRecord } from "@lando/sdk/landofile";
import { RouteFilterKind } from "@lando/sdk/schema";
import { Schema } from "effect";

const isFilterKind = Schema.is(RouteFilterKind);
type RecordValue = Readonly<Record<string, unknown>>;

const visitList = (
  owner: RecordValue,
  field: string,
  optional: boolean,
  oldKey: "_tag" | "type",
  legacy: boolean,
) => {
  if (optional && !Object.hasOwn(owner, field)) return owner;
  const list = owner[field];
  if (!Object.hasOwn(owner, field) || !Array.isArray(list)) return field;
  const migrated: RecordValue[] = [];
  for (const [index, item] of list.entries()) {
    const coordinate = `${field}[${index}]`;
    if (!isPlainRecord(item)) return coordinate;
    if (!legacy) {
      if (Object.hasOwn(item, oldKey)) return `${coordinate}.${oldKey}`;
      continue;
    }
    const kind = item[oldKey];
    if (
      !Object.hasOwn(item, oldKey) ||
      Object.hasOwn(item, "kind") ||
      !(oldKey === "_tag" ? kind === "internal" || kind === "published" : isFilterKind(kind))
    ) {
      return `${coordinate}.${oldKey}`;
    }
    const { [oldKey]: _old, ...fields } = item;
    migrated.push({ ...fields, kind });
  }
  return legacy && list.length > 0 ? { ...owner, [field]: migrated } : owner;
};

export const visitAppliedNetworkVocabulary = (raw: unknown, legacy: boolean): RecordValue | string => {
  if (!isPlainRecord(raw)) return "plan";
  const { services, routes } = raw;
  if (!Object.hasOwn(raw, "services") || !isPlainRecord(services)) return "services";
  if (!Object.hasOwn(raw, "routes") || !Array.isArray(routes)) return "routes";
  const nextServices: [string, RecordValue][] = [];
  for (const [index, [name, service]] of Object.entries(services).entries()) {
    if (!isPlainRecord(service)) return `services[${index}]`;
    const next = visitList(service, "endpoints", false, "_tag", legacy);
    if (typeof next === "string") return `services[${index}].${next}`;
    if (legacy) nextServices.push([name, next]);
  }
  const nextRoutes: RecordValue[] = [];
  for (const [index, route] of routes.entries()) {
    if (!isPlainRecord(route)) return `routes[${index}]`;
    const next = visitList(route, "filters", true, "type", legacy);
    if (typeof next === "string") return `routes[${index}].${next}`;
    if (legacy) nextRoutes.push(next);
  }
  return legacy ? { ...raw, services: Object.fromEntries(nextServices), routes: nextRoutes } : raw;
};
