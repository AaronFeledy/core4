import { LandofileValidationError } from "@lando/sdk/errors";
import {
  type ValueWithOrigins,
  isLandofileOverride,
  isLandofileReset,
  isPlainRecord,
  override,
} from "@lando/sdk/landofile";
import type { ValidationIssuePath } from "@lando/sdk/schema";
import { keyValueEntryPath } from "./load-expression-shape.ts";
import type { AuthoredOrigin, PreparedOverlay } from "./pipeline/prepare.ts";

export const normalizeEnvironmentSites = (input: PreparedOverlay): ValueWithOrigins<AuthoredOrigin> => {
  const visit = (
    entry: ValueWithOrigins<AuthoredOrigin>,
    path: ValidationIssuePath,
  ): ValueWithOrigins<AuthoredOrigin> => {
    const { value, origins } = entry;
    if (isLandofileReset(value)) return entry;
    if (isLandofileOverride(value)) {
      const payload = visit({ value: value.value, origins }, path);
      return { value: override(payload.value), origins: payload.origins };
    }
    if (Array.isArray(value) && keyValueEntryPath([...path, 0])) {
      const children = new Map<string | number, typeof origins>();
      const values: [string, string][] = [];
      for (const [index, item] of value.entries()) {
        const origin = origins.children.get(index) ?? origins;
        const equal = typeof item === "string" ? item.indexOf("=") : -1;
        if (typeof item === "string" && equal < 0 && path[2] === "labels") {
          children.set(item, origin);
          values.push([item, ""]);
          continue;
        }
        if (typeof item !== "string" || equal < 0 || item.slice(0, equal) === "__proto__")
          throw new LandofileValidationError({
            file: origin.source.file,
            message: "Environment list entries require a nonreserved KEY=value.",
            issues: [
              { path: [...path, index], message: "Expected a nonreserved KEY=value.", source: origin.source },
            ],
            remediation: "Use KEY=value entries or an environment mapping.",
          });
        const key = item.slice(0, equal);
        children.set(key, origin);
        values.push([key, item.slice(equal + 1)]);
      }
      return { value: Object.fromEntries(values), origins: { ...origins, children } };
    }
    if (Array.isArray(value)) {
      const children = new Map(origins.children);
      return {
        value: value.map((item, index) => {
          const child = visit({ value: item, origins: children.get(index) ?? origins }, [...path, index]);
          children.set(index, child.origins);
          return child.value;
        }),
        origins: { ...origins, children },
      };
    }
    if (isPlainRecord(value)) {
      const children = new Map(origins.children);
      const values = Object.entries(value).map(([key, item]) => {
        const child = visit({ value: item, origins: children.get(key) ?? origins }, [...path, key]);
        children.set(key, child.origins);
        return [key, child.value];
      });
      return { value: Object.fromEntries(values), origins: { ...origins, children } };
    }
    return entry;
  };
  return visit(input, []);
};
