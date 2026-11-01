import { join } from "node:path";
import { resolveHostHome } from "@lando/paths";
import { RecipeSourceError } from "@lando/sdk/errors";

type Environment = Readonly<Record<string, string | undefined>>;

export interface NpmRegistryConfig {
  readonly path: string;
  readonly registryFor: (packageName: string, override?: string) => string;
  readonly authorizationFor: (requestUrl: string, registry: string) => string | undefined;
  readonly redactionTokens: ReadonlyArray<string>;
  readonly authRemediation: (registry: string) => string;
}

export const expandNpmEnvironment = (value: string, env: Environment): string =>
  value.replace(
    /(?<!\\)(\\*)\$\{([^${}?]+)(\?)?\}/g,
    (match: string, slashes: string, name: string, optional: string | undefined) => {
      const prefix = slashes.slice(0, Math.floor(slashes.length / 2));
      if (slashes.length % 2 === 1) return `${prefix}\${${name}${optional ?? ""}}`;
      return prefix + (env[name] ?? (optional === "?" ? "" : match.slice(slashes.length)));
    },
  );

const iniValue = (value: string): string => {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const decoded: unknown = JSON.parse(value);
      return typeof decoded === "string" ? decoded : "";
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return value;
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === ";" || char === "#") break;
    const next = value[index + 1];
    if (char === "\\" && (next === ";" || next === "#" || next === "\\")) {
      result += next;
      index++;
    } else result += char;
  }
  return result.trim();
};

export const parseNpmRegistryConfig = (
  text: string,
  env: Environment = {},
  path = "~/.npmrc",
): NpmRegistryConfig => {
  const config = new Map<string, string>();
  let section = false;
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === "" || /^[#;]/u.test(line)) continue;
    if (line.startsWith("[")) {
      section = true;
      continue;
    }
    if (section) continue;
    const equals = line.indexOf("=");
    if (equals < 0) continue;
    const key = expandNpmEnvironment(line.slice(0, equals).trim(), env);
    if (key.endsWith("[]")) continue;
    config.set(key, expandNpmEnvironment(iniValue(line.slice(equals + 1).trim()), env));
  }
  for (const [name, value] of Object.entries(env)) {
    if (!/^npm_config_/iu.test(name) || !value) continue;
    const rawKey = name.slice(11);
    const key = rawKey.startsWith("//") ? rawKey : rawKey.replace(/(?!^)_/gu, "-").toLowerCase();
    config.set(expandNpmEnvironment(key, env), expandNpmEnvironment(value, env));
  }
  const walk = (url: URL): string | undefined => {
    let key = `//${url.host}${url.pathname}`;
    while (key.length > 2) {
      const token = config.get(`${key}:_authToken`);
      if (token) return token;
      key = key.replace(/([^/]+|\/)$/u, "");
    }
    return undefined;
  };
  const tokenFor = (requestUrl: string, registry: string): string | undefined => {
    const request = new URL(requestUrl);
    const base = new URL(registry);
    if (request.host !== base.host) return undefined;
    return walk(request) ?? (request.href !== base.href ? walk(base) : undefined);
  };
  const tokens = [...config]
    .filter(([key]) => key.startsWith("//") && key.endsWith(":_authToken"))
    .map(([, value]) => value)
    .filter((value) => value !== "" && !/\$\{[^}]+\}/u.test(value));
  return {
    path,
    registryFor: (name, override) =>
      override ??
      (name.startsWith("@") ? config.get(`${name.split("/")[0]}:registry`) : undefined) ??
      config.get("registry") ??
      "https://registry.npmjs.org/",
    authorizationFor: (url, registry) => {
      const token = tokenFor(url, registry);
      return token && !/\$\{[^}]+\}/u.test(token) ? `Bearer ${token}` : undefined;
    },
    redactionTokens: tokens,
    authRemediation: (registry) => {
      const url = new URL(registry);
      const key = `//${url.host}${url.pathname.replace(/\/*$/u, "/")}:_authToken`;
      const configured = tokenFor(registry, registry);
      const missing = [...(configured ?? "").matchAll(/\$\{([^}?]+)\??\}/gu)].map((match) => match[1]);
      if (missing.length > 0)
        return `Your npm user config (${path}) reads the ${key} token from ${missing.join(", ")}, which is not set. Export it in the shell that runs Lando, then retry.`;
      if (configured !== undefined)
        return `The registry rejected the ${key} token from your npm configuration (${path} or npm_config_* environment variables). Replace it with a token that can access this package, then retry.`;
      return `Add a line to your npm user config (${path}) that sets ${key} to \${NPM_TOKEN}, then export NPM_TOKEN with your registry token and retry.`;
    },
  };
};

export interface NpmRegistryConfigSources {
  /** Environment for `npm_config_*` overrides and `${VAR}` expansion. */
  readonly env?: Environment;
  readonly home?: string;
  /** False skips the npm user config file. */
  readonly user?: boolean;
}

export const loadNpmRegistryConfig = async (
  options: NpmRegistryConfigSources & { readonly readFile?: (path: string) => Promise<string> } = {},
): Promise<NpmRegistryConfig> => {
  const env = options.env ?? process.env;
  const home = options.home ?? resolveHostHome({ env: { ...env } });
  const configured = Object.entries(env).find(
    ([key, value]) => /^npm_config_userconfig$/iu.test(key) && value?.trim(),
  );
  const rawPath = configured?.[1];
  const path = rawPath
    ? rawPath.startsWith("~/")
      ? join(home, rawPath.slice(2))
      : rawPath
    : join(home, ".npmrc");
  if (options.user === false) return parseNpmRegistryConfig("", env, path);
  let text: string;
  try {
    text = await (options.readFile ?? ((file) => Bun.file(file).text()))(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") text = "";
    else
      throw new RecipeSourceError({
        message: `Could not read npm user config ${path}.`,
        source: path,
        kind: "registry-failed",
        remediation: `Check read permissions for ${path}, or set NPM_CONFIG_USERCONFIG to a readable npm config file.`,
      });
  }
  return parseNpmRegistryConfig(text, env, path);
};

/**
 * One lazy snapshot per operation, never shared across retained invocations.
 * `register` receives the snapshot's tokens before any request can use them.
 */
export const npmRegistryConfigSnapshot = (
  register?: (tokens: ReadonlyArray<string>) => Promise<void>,
  sources: NpmRegistryConfigSources = {},
): (() => Promise<NpmRegistryConfig>) => {
  let snapshot: Promise<NpmRegistryConfig> | undefined;
  return () => {
    snapshot ??= loadNpmRegistryConfig(sources).then(async (config) => {
      if (register !== undefined) await register(config.redactionTokens);
      return config;
    });
    return snapshot;
  };
};
