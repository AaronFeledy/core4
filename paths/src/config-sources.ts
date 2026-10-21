import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { HostPlatform } from "@lando/sdk/schema";
import type { RootOverrides } from "@lando/sdk/services";
import { ROOT_ENV_VARIABLES, envOverlayWithVariables } from "./overlay.ts";
import { nonEmpty, normalizeHostPlatform, platformDefaults } from "./paths-platform.ts";
import { parseMinimalYaml } from "./yaml-min.ts";

export interface ConfigSourcePolicy {
  readonly user: boolean;
  readonly env: boolean;
}

export interface ConfigSourceInputs {
  readonly env: Record<string, string | undefined>;
  readonly host?: Readonly<Record<string, unknown>> | undefined;
  readonly sources: ConfigSourcePolicy;
  readonly rootOverrides?: RootOverrides;
  readonly platform?: HostPlatform;
}

export type ConfigLayer =
  | { readonly layer: "default" | "host"; readonly tree: Record<string, unknown> }
  | {
      readonly layer: "env";
      readonly tree: Record<string, unknown>;
      readonly variables: ReadonlyMap<string, string>;
    }
  | {
      readonly layer: "config-file" | "config-drop-in";
      readonly file: string;
      readonly tree: Record<string, unknown>;
      readonly error?: string;
    };

export const configRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readLayer = (file: string, layer: "config-file" | "config-drop-in"): ConfigLayer => {
  try {
    return { layer, file, tree: parseMinimalYaml(readFileSync(file, "utf8")) };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { layer, file, tree: {} };
    }
    return { layer, file, tree: {}, error: error instanceof Error ? error.message : String(error) };
  }
};

/** LANDO root variables and generic root overlays are disabled with sources.env.
 * Platform identity (HOME/XDG/APPDATA) still defines platform defaults. Files can
 * never relocate discovery: userConfRoot is option/host, then env, then default.
 * Empty root strings are unset at every tier of layered root resolution.
 */
export const readGlobalConfigSources = (inputs: ConfigSourceInputs): readonly ConfigLayer[] => {
  const overrides = inputs.rootOverrides ?? {};
  const defaults = platformDefaults(
    inputs.platform ?? normalizeHostPlatform({ platform: overrides.platform, env: inputs.env }),
    {
      ...overrides,
      env: inputs.env,
    },
  );
  const environment = envOverlayWithVariables(inputs.sources.env ? inputs.env : {});
  const host: Record<string, unknown> = { ...inputs.host };
  for (const key of ["userConfRoot", "userDataRoot", "userCacheRoot", "systemPluginRoot"] as const) {
    const value = overrides[key];
    if (value !== undefined && value !== "") host[key] = value;
  }
  const hostConf = typeof host.userConfRoot === "string" ? nonEmpty(host.userConfRoot) : undefined;
  const envConf =
    typeof environment.tree.userConfRoot === "string" ? nonEmpty(environment.tree.userConfRoot) : undefined;
  const userConfRoot = hostConf ?? envConf ?? defaults.userConfRoot;
  const layers: ConfigLayer[] = [
    { layer: "default", tree: { ...defaults, userConfRoot, defaultProviderId: "lando" } },
  ];
  if (inputs.sources.user) {
    const fileLayer = readLayer(join(userConfRoot, "config.yml"), "config-file");
    layers.push(fileLayer);
    let names: string[] = [];
    try {
      names = readdirSync(join(userConfRoot, "config.d"))
        .filter((name) => name.endsWith(".yml"))
        .sort();
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        layers.push({
          layer: "config-drop-in",
          file: join(userConfRoot, "config.d"),
          tree: {},
          error: String(error),
        });
      }
    }
    for (const name of names) layers.push(readLayer(join(userConfRoot, "config.d", name), "config-drop-in"));
  }
  if (inputs.sources.env) layers.push({ layer: "env", ...environment, tree: environment.tree });
  layers.push({ layer: "host", tree: host });
  return layers;
};

export interface ConfigOrigin {
  readonly layer: ConfigLayer;
  readonly path: readonly (string | number)[];
}

export interface MergedConfigSources {
  readonly tree: Record<string, unknown>;
  readonly originAt: (path: readonly (string | number)[]) => ConfigOrigin;
}

/** Segment-array keys preserve literal dots. Replacement clears all old descendants. */
export const mergeGlobalConfigSources = (layers: readonly ConfigLayer[]): MergedConfigSources => {
  const origins = new Map<string, ConfigOrigin>();
  const discoveryRootFixed = layers.some((layer) => layer.layer === "default");
  let tree: Record<string, unknown> = {};
  const fold = (
    base: Record<string, unknown>,
    value: Record<string, unknown>,
    origin: ConfigOrigin,
  ): Record<string, unknown> => {
    const result = { ...base };
    origins.set(JSON.stringify(origin.path), origin);
    for (const [key, entry] of Object.entries(value)) {
      if (
        discoveryRootFixed &&
        origin.path.length === 0 &&
        Object.hasOwn(ROOT_ENV_VARIABLES, key) &&
        entry === ""
      )
        continue;
      if (
        discoveryRootFixed &&
        origin.path.length === 0 &&
        key === "userConfRoot" &&
        (origin.layer.layer === "config-file" || origin.layer.layer === "config-drop-in")
      )
        continue;
      const path = [...origin.path, key];
      const previous = result[key];
      const whole = path.length === 1 && (key === "appEnv" || key === "appLabels");
      if (!whole && configRecord(previous) && configRecord(entry)) {
        result[key] = fold(previous, entry, { layer: origin.layer, path });
      } else {
        for (const [id, old] of origins) {
          if (path.every((segment, index) => old.path[index] === segment)) origins.delete(id);
        }
        const capture = (input: unknown, at: readonly (string | number)[]): void => {
          origins.set(JSON.stringify(at), { layer: origin.layer, path: at });
          if (configRecord(input)) for (const [child, v] of Object.entries(input)) capture(v, [...at, child]);
          else if (Array.isArray(input)) input.forEach((v, index) => capture(v, [...at, index]));
        };
        capture(entry, path);
        result[key] = entry;
      }
    }
    return result;
  };
  for (const layer of layers) tree = fold(tree, layer.tree, { layer, path: [] });
  return {
    tree,
    originAt: (path) => {
      for (let length = path.length; length >= 0; length -= 1) {
        const origin = origins.get(JSON.stringify(path.slice(0, length)));
        if (origin !== undefined) return origin;
      }
      return { layer: { layer: "default", tree: {} }, path: [] };
    },
  };
};
