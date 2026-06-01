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
