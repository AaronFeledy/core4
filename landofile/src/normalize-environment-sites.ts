import { LandofileValidationError } from "@lando/sdk/errors";
import {
  type ValueWithOrigins,
  isLandofileOverride,
  isLandofileReset,
  isPlainRecord,
  override,
} from "@lando/sdk/landofile";
import type { ValidationIssuePath } from "@lando/sdk/schema";
import { Predicate } from "effect";
import { keyValueEntryPath } from "./load-expression-shape.ts";
import type { LoadFailureRecorder } from "./load-failures.ts";
import type { AuthoredOrigin, PreparedOverlay } from "./pipeline/prepare.ts";

export const normalizeEnvironmentSites = (
  input: PreparedOverlay & { readonly recorder?: LoadFailureRecorder | undefined },
): ValueWithOrigins<AuthoredOrigin> => {
  const visit = (
    entry: ValueWithOrigins<AuthoredOrigin>,
    path: ValidationIssuePath,
  ): ValueWithOrigins<AuthoredOrigin> => {
    const { value, origins } = entry;
    if (path.length === 1 && !["services", "tooling", "toolingDefaults", "events"].includes(String(path[0])))
      return entry;
    if (!Predicate.isObjectOrArray(value)) return entry;
    if (isLandofileReset(value)) return entry;
    if (isLandofileOverride(value)) {
      const payload = visit({ value: value.value, origins }, path);
      if (payload.value === value.value && payload.origins === origins) return entry;
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
        if (typeof item !== "string" || equal < 0 || item.slice(0, equal) === "__proto__") {
          const error = new LandofileValidationError({
            file: origin.source.file,
            message: "Environment list entries require a nonreserved KEY=value.",
            issues: [
              { path: [...path, index], message: "Expected a nonreserved KEY=value.", source: origin.source },
            ],
            remediation: "Use KEY=value entries or an environment mapping.",
          });
          if (input.recorder === undefined) throw error;
          input.recorder.record(error, origin.source);
          continue;
        }
        const key = item.slice(0, equal);
        children.set(key, origin);
        values.push([key, item.slice(equal + 1)]);
      }
      return { value: Object.fromEntries(values), origins: { ...origins, children } };
    }
    if (Array.isArray(value) || isPlainRecord(value)) {
      let changed: { value: object; children: Map<string | number, typeof origins> } | undefined;
      for (const key of Object.keys(value)) {
        const part = Array.isArray(value) ? Number(key) : key;
        const item = Reflect.get(value, key);
        const origin = origins.children.get(part) ?? origins;
        const child = visit({ value: item, origins: origin }, [...path, part]);
        if (child.value === item && child.origins === origin) continue;
        changed ??= {
          value: Array.isArray(value) ? [...value] : { ...value },
          children: new Map(origins.children),
        };
        Reflect.set(changed.value, key, child.value);
        changed.children.set(part, child.origins);
      }
      return changed === undefined
        ? entry
        : { value: changed.value, origins: { ...origins, children: changed.children } };
    }
    return entry;
  };
  return visit(input, []);
};
