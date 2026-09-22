import type { ConfigTranslateDiagnostic } from "@lando/sdk/schema";
import type { Lando3Path, LegacyOccurrence } from "./contract.ts";

export type V4Wire = Readonly<Record<string, unknown>>;

export interface ServiceLoweringContext {
  readonly serviceName: string;
  readonly keyPath: Lando3Path;
  readonly fallbackSourceId: string;
  /** Looks up a path relative to this service, such as ["overrides", "tty"]. */
  readonly occurrenceAt: (relative: Lando3Path) => LegacyOccurrence | undefined;
  readonly topLevel: {
    readonly excludes: ReadonlyArray<string>;
    readonly includes: ReadonlyArray<string>;
  };
}

export interface LoweringPatch {
  readonly patch: V4Wire;
  readonly companions?: Readonly<Record<string, V4Wire>>;
  readonly topLevel?: V4Wire;
  readonly diagnostics: ReadonlyArray<ConfigTranslateDiagnostic>;
  readonly blocked?: true;
}

export const emptyPatch: LoweringPatch = { patch: {}, diagnostics: [] };

export const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

export const asStringArray = (value: unknown): ReadonlyArray<string> | undefined => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((item: unknown) => typeof item === "string")) return value;
  return undefined;
};

/**
 * Lando 3 webroots are app-root relative, while every Lando 4 service schema
 * takes an absolute container path. The app is mounted at `/app`, so an
 * authored relative webroot is that path with the mount target in front.
 */
export const containerWebroot = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  if (value.startsWith("/")) return value;
  const relative = value.replace(/^(?:\.\/+)+/u, "").replace(/\/+$/u, "");
  return relative === "" || relative === "." ? "/app" : `/app/${relative}`;
};

const CONCATENATED_WIRE_KEYS: ReadonlySet<string> = new Set(["mounts", "artifact", "app"]);

const mergeWire = (left: V4Wire, right: V4Wire): V4Wire =>
  Object.fromEntries(
    [...new Set([...Object.keys(left), ...Object.keys(right)])].map((key) => {
      const previous = Object.hasOwn(left, key) ? left[key] : undefined;
      if (!Object.hasOwn(right, key)) return [key, previous];
      const next = right[key];
      if (CONCATENATED_WIRE_KEYS.has(key) && Array.isArray(previous) && Array.isArray(next)) {
        return [key, [...previous, ...next]];
      }
      return [key, isPlainObject(previous) && isPlainObject(next) ? mergeWire(previous, next) : next];
    }),
  );

export const mergePatches = (...patches: ReadonlyArray<LoweringPatch>): LoweringPatch =>
  patches.reduce<LoweringPatch>((merged, next) => {
    const companions = new Map(Object.entries(merged.companions ?? {}));
    for (const [name, service] of Object.entries(next.companions ?? {})) {
      companions.set(name, mergeWire(companions.get(name) ?? {}, service));
    }
    return {
      patch: mergeWire(merged.patch, next.patch),
      ...(merged.companions !== undefined || next.companions !== undefined
        ? { companions: Object.fromEntries(companions) }
        : {}),
      ...(merged.topLevel !== undefined || next.topLevel !== undefined
        ? { topLevel: mergeWire(merged.topLevel ?? {}, next.topLevel ?? {}) }
        : {}),
      diagnostics: [...merged.diagnostics, ...next.diagnostics],
      ...(merged.blocked === true || next.blocked === true ? { blocked: true as const } : {}),
    };
  }, emptyPatch);

export const blockedPatch = (diagnostics: ReadonlyArray<ConfigTranslateDiagnostic>): LoweringPatch => ({
  patch: {},
  diagnostics,
  blocked: true,
});
