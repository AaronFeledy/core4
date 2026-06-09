import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { resolveUserConfRoot, resolveUserDataRoot } from "../../src/config/roots.ts";

const ENV_KEYS = [
  "HOME",
  "LANDO_USER_CONF_ROOT",
  "LANDO_USER_DATA_ROOT",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
] as const;

const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const setEnv = (env: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) => {
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
};

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value !== undefined) process.env[key] = value;
  }
});

describe("config root resolution", () => {
  test("LANDO_USER_DATA_ROOT wins over XDG_DATA_HOME and HOME", () => {
    setEnv({ HOME: "/home/test", XDG_DATA_HOME: "/xdg/data", LANDO_USER_DATA_ROOT: "/lando/data" });

    expect(resolveUserDataRoot()).toBe("/lando/data");
  });

  test("XDG_DATA_HOME feeds the default user data root", () => {
    setEnv({ HOME: "/home/test", XDG_DATA_HOME: "/xdg/data" });

    expect(resolveUserDataRoot()).toBe("/xdg/data/lando");
  });

  test("HOME feeds the fallback user data root", () => {
    setEnv({ HOME: "/home/test" });

    expect(resolveUserDataRoot()).toBe("/home/test/.local/share/lando");
  });

  test("empty XDG_DATA_HOME is treated as unset and falls back to HOME", () => {
    setEnv({ HOME: "/home/test", XDG_DATA_HOME: "" });

    expect(resolveUserDataRoot()).toBe("/home/test/.local/share/lando");
  });

  test("LANDO_USER_CONF_ROOT wins over XDG_CONFIG_HOME and HOME", () => {
    setEnv({ HOME: "/home/test", XDG_CONFIG_HOME: "/xdg/config", LANDO_USER_CONF_ROOT: "/lando/conf" });

    expect(resolveUserConfRoot()).toBe("/lando/conf");
  });

  test("XDG_CONFIG_HOME is ignored by the current user config root precedence", () => {
    setEnv({ HOME: "/home/test", XDG_CONFIG_HOME: "/xdg/config" });

    expect(resolveUserConfRoot()).toBe("/home/test/.lando");
  });

  test("missing HOME falls back to dot-relative roots", () => {
    setEnv({});

    expect(resolveUserDataRoot()).toBe(".local/share/lando");
    expect(resolveUserConfRoot()).toBe("./.lando");
  });
});

describe("config.yml userDataRoot layer (spec §7.5)", () => {
  let confRoot: string;

  const writeConfig = (contents: string) => {
    writeFileSync(join(confRoot, "config.yml"), contents);
  };

  afterEach(() => {
    rmSync(confRoot, { recursive: true, force: true });
  });

  const withConfRoot = () => {
    confRoot = mkdtempSync(join(tmpdir(), "lando-conf-"));
    return confRoot;
  };

  test("config.yml userDataRoot is honored when no env override is set", () => {
    setEnv({ HOME: "/home/test", XDG_DATA_HOME: "/xdg/data", LANDO_USER_CONF_ROOT: withConfRoot() });
    writeConfig("userDataRoot: /from/config\n");

    expect(resolveUserDataRoot()).toBe("/from/config");
  });

  test("LANDO_USER_DATA_ROOT wins over config.yml without reading the file", () => {
    setEnv({
      HOME: "/home/test",
      LANDO_USER_CONF_ROOT: withConfRoot(),
      LANDO_USER_DATA_ROOT: "/from/env",
    });
    writeConfig("userDataRoot: /from/config\n");

    expect(resolveUserDataRoot()).toBe("/from/env");
  });

  test("quoted and comment-trailing config values are parsed", () => {
    setEnv({ HOME: "/home/test", LANDO_USER_CONF_ROOT: withConfRoot() });
    writeConfig('userDataRoot: "/quoted/data" # trailing comment\n');

    expect(resolveUserDataRoot()).toBe("/quoted/data");
  });

  test("a nested userDataRoot block is ignored and falls back to the default", () => {
    setEnv({ HOME: "/home/test", XDG_DATA_HOME: "/xdg/data", LANDO_USER_CONF_ROOT: withConfRoot() });
    writeConfig("userDataRoot:\n  nested: value\n");

    expect(resolveUserDataRoot()).toBe("/xdg/data/lando");
  });

  test("config.yml without userDataRoot falls back to the platform default", () => {
    setEnv({ HOME: "/home/test", XDG_DATA_HOME: "/xdg/data", LANDO_USER_CONF_ROOT: withConfRoot() });
    writeConfig("defaultProviderId: lando\n");

    expect(resolveUserDataRoot()).toBe("/xdg/data/lando");
  });

  test("a later top-level scalar wins over an earlier nested block (matches ConfigService last-wins)", () => {
    setEnv({ HOME: "/home/test", XDG_DATA_HOME: "/xdg/data", LANDO_USER_CONF_ROOT: withConfRoot() });
    writeConfig("userDataRoot:\n  nested: value\nuserDataRoot: /from/config\n");

    expect(resolveUserDataRoot()).toBe("/from/config");
  });

  test("duplicate top-level userDataRoot keys keep the last value (matches ConfigService)", () => {
    setEnv({ HOME: "/home/test", XDG_DATA_HOME: "/xdg/data", LANDO_USER_CONF_ROOT: withConfRoot() });
    writeConfig("userDataRoot: /first\nuserDataRoot: /second\n");

    expect(resolveUserDataRoot()).toBe("/second");
  });

  test("an indented userDataRoot recorded on the root object is honored (matches ConfigService)", () => {
    setEnv({ HOME: "/home/test", XDG_DATA_HOME: "/xdg/data", LANDO_USER_CONF_ROOT: withConfRoot() });
    writeConfig("defaultProviderId: lando\n  userDataRoot: /indented\n");

    expect(resolveUserDataRoot()).toBe("/indented");
  });

  test("a YAML null userDataRoot falls back instead of becoming the literal path 'null'", () => {
    setEnv({ HOME: "/home/test", XDG_DATA_HOME: "/xdg/data", LANDO_USER_CONF_ROOT: withConfRoot() });
    writeConfig("userDataRoot: null\n");

    expect(resolveUserDataRoot()).toBe("/xdg/data/lando");
  });

  test("a malformed config.yml falls back to the platform default instead of breaking shell startup", () => {
    setEnv({ HOME: "/home/test", XDG_DATA_HOME: "/xdg/data", LANDO_USER_CONF_ROOT: withConfRoot() });
    writeConfig("userDataRoot: [unsupported]\n");

    expect(resolveUserDataRoot()).toBe("/xdg/data/lando");
  });
});
