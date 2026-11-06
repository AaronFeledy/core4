import { describe, expect, test } from "bun:test";
import {
  expandNpmEnvironment,
  loadNpmRegistryConfig,
  parseNpmRegistryConfig,
} from "../../src/recipes/npm-registry-config";

describe("npm registry configuration", () => {
  test.each([
    [
      "@acme:registry=https://scoped.test/\nregistry=https://fallback.test/",
      {},
      "@acme/plugin",
      undefined,
      "https://scoped.test/",
    ],
    ["registry=https://fallback.test/", {}, "plugin", undefined, "https://fallback.test/"],
    ["", {}, "plugin", undefined, "https://registry.npmjs.org/"],
    ["registry=https://fallback.test/", {}, "plugin", "https://override.test", "https://override.test"],
    [
      "registry=https://fallback.test/",
      { NPM_CONFIG_REGISTRY: "https://upper.test/" },
      "plugin",
      undefined,
      "https://upper.test/",
    ],
    [
      "registry=https://fallback.test/",
      { npm_config_registry: "https://lower.test/" },
      "plugin",
      undefined,
      "https://lower.test/",
    ],
    [
      "",
      { "npm_config_@acme:registry": "https://env.test/" },
      "@acme/plugin",
      undefined,
      "https://env.test/",
    ],
  ] as const)("resolves registry with file %s and env %j", (text, env, name, override, expected) => {
    const config = parseNpmRegistryConfig(text, env);
    const registry = config.registryFor(name, override);
    expect(registry).toBe(expected);
  });

  test.each([
    ["${TOKEN}", {}, "${TOKEN}"],
    ["${TOKEN?}", {}, ""],
    ["\\${TOKEN}", { TOKEN: "secret" }, "${TOKEN}"],
    ["\\\\${TOKEN}", { TOKEN: "secret" }, "\\secret"],
    ["${TOKEN}", { TOKEN: "secret" }, "secret"],
  ] as const)("expands %s according to npm semantics", (value, env, expected) => {
    const expanded = expandNpmEnvironment(value, env);
    expect(expanded).toBe(expected);
  });

  test("parses comments, quoting, escapes, keys and ignores sections and arrays", () => {
    const text = ` # comment
; comment
bare
registry[] = ignored
registry = 'https://fallback.test/'
@${"${SCOPE}"}:registry = "https://scoped.test/"
//scoped.test/:_authToken = a\\;b\\#c\\\\d ; comment
[section]
registry=https://ignored.test/
//scoped.test/:_authToken=ignored`;
    const config = parseNpmRegistryConfig(text, { SCOPE: "acme" });
    expect(config.registryFor("@acme/plugin")).toBe("https://scoped.test/");
    expect(config.registryFor("plugin")).toBe("https://fallback.test/");
    expect(config.authorizationFor("https://scoped.test/pkg", "https://scoped.test/")).toBe(
      "Bearer a;b#c\\d",
    );
  });

  test.each([
    ["//npm.test/:_authToken=secret", "https://npm.test/pkg", "https://npm.test/", "Bearer secret"],
    ["//npm.test:_authToken=secret", "https://npm.test/pkg", "https://npm.test/", "Bearer secret"],
    [
      "//npm.test/acme/:_authToken=secret",
      "https://npm.test/acme/pkg",
      "https://npm.test/acme/",
      "Bearer secret",
    ],
    [
      "//npm.test/acme:_authToken=secret",
      "https://npm.test/acme/pkg",
      "https://npm.test/acme/",
      "Bearer secret",
    ],
    [
      "//npm.test:8443/:_authToken=secret",
      "https://npm.test:8443/pkg",
      "https://npm.test:8443/",
      "Bearer secret",
    ],
    [
      "//npm.test/acme/:_authToken=secret",
      "https://npm.test/download/pkg",
      "https://npm.test/acme/",
      "Bearer secret",
    ],
    ["//npm.test/:_authToken=secret", "https://other.test/pkg", "https://npm.test/", undefined],
    [
      "//npm.test/:_authToken=secret\n//other.test/:_authToken=other",
      "https://other.test/pkg",
      "https://npm.test/",
      undefined,
    ],
    ["_authToken=secret", "https://npm.test/pkg", "https://npm.test/", undefined],
    ["//npm.test/:_authToken=${MISSING}", "https://npm.test/pkg", "https://npm.test/", undefined],
  ] as const)("matches token config %s for %s", (text, url, registry, expected) => {
    const config = parseNpmRegistryConfig(text);
    const authorization = config.authorizationFor(url, registry);
    expect(authorization).toBe(expected);
  });

  test("reports unset token variables without exposing token content", () => {
    const config = parseNpmRegistryConfig("//npm.test/acme/:_authToken=prefix${MISSING}");
    const remediation = config.authRemediation("https://npm.test/acme/");
    expect(remediation).toContain(
      "reads the //npm.test/acme/:_authToken token from MISSING, which is not set",
    );
    expect(remediation).not.toContain("prefix");
  });

  test("prefers the most specific request token over parent and registry tokens", () => {
    const config = parseNpmRegistryConfig(
      "//npm.test/:_authToken=host\n//npm.test/download/:_authToken=download\n//npm.test/acme/:_authToken=registry",
    );

    const authorization = config.authorizationFor("https://npm.test/download/pkg", "https://npm.test/acme/");

    expect(authorization).toBe("Bearer download");
  });

  test("explains a rejected token and a missing token without exposing token content", () => {
    const rejected = parseNpmRegistryConfig("//npm.test/:_authToken=literal-secret").authRemediation(
      "https://npm.test/",
    );
    expect(rejected).toContain("rejected the //npm.test/:_authToken token");
    expect(rejected).not.toContain("literal-secret");
    const absent = parseNpmRegistryConfig("").authRemediation("https://npm.test/acme");
    expect(absent).toContain("sets //npm.test/acme/:_authToken to ${NPM_TOKEN}");
    expect(absent).toContain("export NPM_TOKEN");
  });

  test.each(["NPM_CONFIG_USERCONFIG", "npm_config_userconfig"])(
    "loads expanded user config from %s",
    async (key) => {
      const reads: string[] = [];
      const config = await loadNpmRegistryConfig({
        env: { [key]: "~/config/npmrc" },
        home: "/home/test",
        readFile: async (path) => {
          reads.push(path);
          return "registry=https://private.test/";
        },
      });
      expect(reads).toEqual(["/home/test/config/npmrc"]);
      expect(config.registryFor("plugin")).toBe("https://private.test/");
    },
  );

  test("uses an empty config when the user file is absent", async () => {
    const config = await loadNpmRegistryConfig({
      env: {},
      home: "/home/test",
      readFile: async () => {
        throw Object.assign(new Error("absent"), { code: "ENOENT" });
      },
    });
    expect(config.registryFor("plugin")).toBe("https://registry.npmjs.org/");
  });

  test("honors environment overrides without reading a disabled user config", async () => {
    const reads: string[] = [];
    const config = await loadNpmRegistryConfig({
      env: { NPM_CONFIG_REGISTRY: "https://env.test/" },
      home: "/home/test",
      user: false,
      readFile: async (path) => {
        reads.push(path);
        throw new Error("User config must not be read");
      },
    });

    expect(reads).toEqual([]);
    expect(config.registryFor("plugin")).toBe("https://env.test/");
  });

  test("reports only the path when reading user config fails", async () => {
    const result = loadNpmRegistryConfig({
      env: {},
      home: "/home/test",
      readFile: async () => {
        throw new Error("secret-content");
      },
    });
    await expect(result).rejects.toMatchObject({ _tag: "RecipeSourceError", source: "/home/test/.npmrc" });
    await expect(result).rejects.not.toThrow("secret-content");
  });
});
