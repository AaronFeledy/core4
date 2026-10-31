import { readFile } from "node:fs/promises";
import { Schema } from "effect";
import type { PackageJson } from "./plugin-build-package";

const Auth = Schema.Struct({
  registries: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.UndefinedOr(Schema.Struct({ token: Schema.optional(Schema.Unknown) })),
    ),
  ),
});
export type PluginRegistryAuth = typeof Auth.Type;
export type PluginAuthReader = (authPath: string) => Promise<PluginRegistryAuth | undefined>;
const normalizeRegistry = (registry: string) => registry.replace(/\/+$/, "");

export const defaultAuthReader: PluginAuthReader = async (path) => {
  const raw = await readFile(path, "utf8").then(
    (text) => text,
    () => undefined,
  );
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    if (cause instanceof SyntaxError) return undefined;
    throw cause;
  }
  const result = Schema.decodeUnknownResult(Auth)(parsed);
  switch (result._tag) {
    case "Success":
      return result.success;
    case "Failure":
      return undefined;
    default:
      return result satisfies never;
  }
};

export const registryToken = (auth: PluginRegistryAuth | undefined, registry: string): string | undefined => {
  const target = normalizeRegistry(registry);
  for (const [key, value] of Object.entries(auth?.registries ?? {})) {
    if (normalizeRegistry(key) !== target) continue;
    const token = value?.token;
    if (typeof token !== "string") continue;
    const trimmed = token.trim();
    if (trimmed !== "") return trimmed;
  }
  return undefined;
};

export const publishConfigRegistry = (pkg: PackageJson): string | undefined => {
  const config = pkg.publishConfig;
  if (typeof config !== "object" || config === null || !("registry" in config)) return undefined;
  return typeof config.registry === "string" ? config.registry : undefined;
};
