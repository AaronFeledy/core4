import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  type RootOverrides,
  makeLandoPaths,
  normalizeHostPlatform,
  resolveLandoRoots,
} from "../../src/config/paths.ts";

// Every test injects env/home/platform through RootOverrides so the suite is
// fully deterministic regardless of the host the suite runs on. We never read
// or mutate the real process environment.

const noEnv: Record<string, string | undefined> = {};

const PLATFORM_CASES = [
  {
    platform: "linux",
    home: "/home/tester",
    env: noEnv,
    defaults: {
      userConfRoot: "/home/tester/.config/lando",
      userCacheRoot: "/home/tester/.cache/lando",
      userDataRoot: "/home/tester/.local/share/lando",
      systemPluginRoot: "/usr/local/share/lando",
    },
  },
  {
    platform: "wsl",
    home: "/home/tester",
    env: noEnv,
    defaults: {
      userConfRoot: "/home/tester/.config/lando",
      userCacheRoot: "/home/tester/.cache/lando",
      userDataRoot: "/home/tester/.local/share/lando",
      systemPluginRoot: "/usr/local/share/lando",
    },
  },
  {
    platform: "darwin",
    home: "/Users/tester",
    env: noEnv,
    defaults: {
      userConfRoot: "/Users/tester/Library/Application Support/Lando",
      userCacheRoot: "/Users/tester/Library/Caches/Lando",
      userDataRoot: "/Users/tester/Library/Application Support/Lando",
      systemPluginRoot: "/usr/local/share/lando",
    },
  },
  {
    platform: "win32",
    home: "C:\\Users\\tester",
    env: {
      APPDATA: "C:\\Users\\tester\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
      PROGRAMDATA: "C:\\ProgramData",
    },
    defaults: {
      userConfRoot: "C:\\Users\\tester\\AppData\\Roaming\\Lando",
      userCacheRoot: "C:\\Users\\tester\\AppData\\Local\\Lando\\Cache",
      userDataRoot: "C:\\Users\\tester\\AppData\\Local\\Lando\\Data",
      systemPluginRoot: "C:\\ProgramData\\Lando",
    },
  },
] as const;

const tmpDirs: string[] = [];
const makeConfRoot = (configYml?: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "lando-paths-test-"));
  tmpDirs.push(dir);
  if (configYml !== undefined) writeFileSync(join(dir, "config.yml"), configYml, "utf8");
  return dir;
};

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("normalizeHostPlatform", () => {
  test("maps node platforms to the host-platform column selector", () => {
    expect(normalizeHostPlatform({ platform: "linux", env: noEnv })).toBe("linux");
    expect(normalizeHostPlatform({ platform: "darwin", env: noEnv })).toBe("darwin");
    expect(normalizeHostPlatform({ platform: "win32", env: noEnv })).toBe("win32");
  });

  test("detects WSL from WSL_DISTRO_NAME / WSL_INTEROP on linux", () => {
    expect(normalizeHostPlatform({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" } })).toBe("wsl");
    expect(normalizeHostPlatform({ platform: "linux", env: { WSL_INTEROP: "/run/x" } })).toBe("wsl");
    // WSL markers on non-linux do not force wsl.
    expect(normalizeHostPlatform({ platform: "darwin", env: { WSL_DISTRO_NAME: "Ubuntu" } })).toBe("darwin");
  });

  test("falls back to linux for unknown platforms", () => {
    expect(normalizeHostPlatform({ platform: "freebsd", env: noEnv })).toBe("linux");
    expect(normalizeHostPlatform({ platform: "openbsd", env: noEnv })).toBe("linux");
  });

  test("defaults to the host platform/env when no input is supplied", () => {
    // Should not throw and should return a member of the HostPlatform union.
    const resolved = normalizeHostPlatform();
    expect(["darwin", "linux", "win32", "wsl"]).toContain(resolved);
  });
});

describe("resolveLandoRoots platform-default matrix (§7.5)", () => {
  const home = "/home/tester";

  test("linux XDG defaults", () => {
    const roots = resolveLandoRoots({ platform: "linux", home, env: noEnv });
    expect(roots.userConfRoot).toBe("/home/tester/.config/lando");
    expect(roots.userCacheRoot).toBe("/home/tester/.cache/lando");
    expect(roots.userDataRoot).toBe("/home/tester/.local/share/lando");
    expect(roots.systemPluginRoot).toBe("/usr/local/share/lando");
  });

  test("linux honors XDG_* env when set", () => {
    const roots = resolveLandoRoots({
      platform: "linux",
      home,
      env: {
        XDG_CONFIG_HOME: "/xdg/config",
        XDG_CACHE_HOME: "/xdg/cache",
        XDG_DATA_HOME: "/xdg/data",
      },
    });
    expect(roots.userConfRoot).toBe("/xdg/config/lando");
    expect(roots.userCacheRoot).toBe("/xdg/cache/lando");
    expect(roots.userDataRoot).toBe("/xdg/data/lando");
  });

  test("wsl resolves to the linux column", () => {
    const linux = resolveLandoRoots({ platform: "linux", home, env: noEnv });
    const wsl = resolveLandoRoots({ platform: "wsl", home, env: noEnv });
    expect(wsl).toEqual(linux);
  });

  test("darwin ~/Library defaults", () => {
    const roots = resolveLandoRoots({ platform: "darwin", home: "/Users/tester", env: noEnv });
    expect(roots.userConfRoot).toBe("/Users/tester/Library/Application Support/Lando");
    expect(roots.userCacheRoot).toBe("/Users/tester/Library/Caches/Lando");
    expect(roots.userDataRoot).toBe("/Users/tester/Library/Application Support/Lando");
    expect(roots.systemPluginRoot).toBe("/usr/local/share/lando");
  });

  test("win32 %APPDATA% / %LOCALAPPDATA% / %PROGRAMDATA% defaults", () => {
    const roots = resolveLandoRoots({
      platform: "win32",
      home: "C:\\Users\\tester",
      env: {
        APPDATA: "C:\\Users\\tester\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
        PROGRAMDATA: "C:\\ProgramData",
      },
    });
    expect(roots.userConfRoot).toBe("C:\\Users\\tester\\AppData\\Roaming\\Lando");
    expect(roots.userCacheRoot).toBe("C:\\Users\\tester\\AppData\\Local\\Lando\\Cache");
    expect(roots.userDataRoot).toBe("C:\\Users\\tester\\AppData\\Local\\Lando\\Data");
    expect(roots.systemPluginRoot).toBe("C:\\ProgramData\\Lando");
  });
});

describe("resolveLandoRoots precedence order (§7.5)", () => {
  const home = "/home/tester";

  for (const entry of PLATFORM_CASES) {
    test(`${entry.platform} defaults cover every root`, () => {
      expect(resolveLandoRoots({ platform: entry.platform, home: entry.home, env: entry.env })).toEqual(
        entry.defaults,
      );
    });

    test(`${entry.platform} explicit overrides win for every root`, () => {
      const roots = resolveLandoRoots({
        platform: entry.platform,
        home: entry.home,
        env: {
          ...entry.env,
          LANDO_USER_CONF_ROOT: "/env/conf",
          LANDO_USER_CACHE_ROOT: "/env/cache",
          LANDO_USER_DATA_ROOT: "/env/data",
          LANDO_SYSTEM_PLUGIN_ROOT: "/env/sys",
        },
        userConfRoot: "/explicit/conf",
        userCacheRoot: "/explicit/cache",
        userDataRoot: "/explicit/data",
        systemPluginRoot: "/explicit/sys",
      });
      expect(roots).toEqual({
        userConfRoot: "/explicit/conf",
        userCacheRoot: "/explicit/cache",
        userDataRoot: "/explicit/data",
        systemPluginRoot: "/explicit/sys",
      });
    });

    test(`${entry.platform} LANDO_* env wins for every root`, () => {
      const confRoot = makeConfRoot(
        ["userCacheRoot: /cfg/cache", "userDataRoot: /cfg/data", "systemPluginRoot: /cfg/sys"].join("\n"),
      );
      const roots = resolveLandoRoots({
        platform: entry.platform,
        home: entry.home,
        env: {
          ...entry.env,
          LANDO_USER_CONF_ROOT: confRoot,
          LANDO_USER_CACHE_ROOT: "/env/cache",
          LANDO_USER_DATA_ROOT: "/env/data",
          LANDO_SYSTEM_PLUGIN_ROOT: "/env/sys",
        },
      });
      expect(roots).toEqual({
        userConfRoot: confRoot,
        userCacheRoot: "/env/cache",
        userDataRoot: "/env/data",
        systemPluginRoot: "/env/sys",
      });
    });

    test(`${entry.platform} config.yml wins over defaults for configurable roots`, () => {
      const confRoot = makeConfRoot(
        [
          "userConfRoot: /cfg/conf",
          "userCacheRoot: /cfg/cache",
          "userDataRoot: /cfg/data",
          "systemPluginRoot: /cfg/sys",
        ].join("\n"),
      );
      const roots = resolveLandoRoots({
        platform: entry.platform,
        home: entry.home,
        env: { ...entry.env, LANDO_USER_CONF_ROOT: confRoot },
      });
      expect(roots).toEqual({
        userConfRoot: confRoot,
        userCacheRoot: "/cfg/cache",
        userDataRoot: "/cfg/data",
        systemPluginRoot: "/cfg/sys",
      });
    });
  }

  test("explicit override wins over env, config, and default for every root", () => {
    const confRoot = makeConfRoot(
      [
        "userConfRoot: /cfg/conf",
        "userCacheRoot: /cfg/cache",
        "userDataRoot: /cfg/data",
        "systemPluginRoot: /cfg/sys",
      ].join("\n"),
    );
    const overrides: RootOverrides = {
      platform: "linux",
      home,
      env: {
        LANDO_USER_CONF_ROOT: confRoot, // locate config.yml here
        LANDO_USER_CACHE_ROOT: "/env/cache",
        LANDO_USER_DATA_ROOT: "/env/data",
        LANDO_SYSTEM_PLUGIN_ROOT: "/env/sys",
      },
      userConfRoot: "/explicit/conf",
      userCacheRoot: "/explicit/cache",
      userDataRoot: "/explicit/data",
      systemPluginRoot: "/explicit/sys",
    };
    const roots = resolveLandoRoots(overrides);
    expect(roots.userConfRoot).toBe("/explicit/conf");
    expect(roots.userCacheRoot).toBe("/explicit/cache");
    expect(roots.userDataRoot).toBe("/explicit/data");
    expect(roots.systemPluginRoot).toBe("/explicit/sys");
  });

  test("env wins over config and default (no explicit override)", () => {
    const confRoot = makeConfRoot(
      ["userCacheRoot: /cfg/cache", "userDataRoot: /cfg/data", "systemPluginRoot: /cfg/sys"].join("\n"),
    );
    const roots = resolveLandoRoots({
      platform: "linux",
      home,
      env: {
        LANDO_USER_CONF_ROOT: confRoot,
        LANDO_USER_CACHE_ROOT: "/env/cache",
        LANDO_USER_DATA_ROOT: "/env/data",
        LANDO_SYSTEM_PLUGIN_ROOT: "/env/sys",
      },
    });
    expect(roots.userConfRoot).toBe(confRoot);
    expect(roots.userCacheRoot).toBe("/env/cache");
    expect(roots.userDataRoot).toBe("/env/data");
    expect(roots.systemPluginRoot).toBe("/env/sys");
  });

  test("config.yml wins over platform default for the three non-conf roots", () => {
    const confRoot = makeConfRoot(
      ["userCacheRoot: /cfg/cache", "userDataRoot: /cfg/data", "systemPluginRoot: /cfg/sys"].join("\n"),
    );
    const roots = resolveLandoRoots({
      platform: "linux",
      home,
      env: { LANDO_USER_CONF_ROOT: confRoot },
    });
    expect(roots.userCacheRoot).toBe("/cfg/cache");
    expect(roots.userDataRoot).toBe("/cfg/data");
    expect(roots.systemPluginRoot).toBe("/cfg/sys");
  });

  test("platform default applies when nothing else is set", () => {
    const roots = resolveLandoRoots({ platform: "linux", home, env: noEnv });
    expect(roots.userCacheRoot).toBe("/home/tester/.cache/lando");
    expect(roots.userDataRoot).toBe("/home/tester/.local/share/lando");
    expect(roots.systemPluginRoot).toBe("/usr/local/share/lando");
  });
});

describe("userConfRoot self-reference rule (§7.5)", () => {
  const home = "/home/tester";

  test("a userConfRoot value inside config.yml never relocates the config load", () => {
    const confRoot = makeConfRoot(["userConfRoot: /should/be/ignored", "userDataRoot: /cfg/data"].join("\n"));
    // config.yml is located via env LANDO_USER_CONF_ROOT; the userConfRoot value
    // INSIDE it must not change where config.yml was read from, and the conf
    // root stays the env value.
    const roots = resolveLandoRoots({
      platform: "linux",
      home,
      env: { LANDO_USER_CONF_ROOT: confRoot },
    });
    expect(roots.userConfRoot).toBe(confRoot);
    // The sibling root is still read from that same config.yml.
    expect(roots.userDataRoot).toBe("/cfg/data");
  });

  test("LANDO_CONFIG__user_conf_root selects which config.yml is read", () => {
    const ignoredRoot = makeConfRoot("userDataRoot: /ignored/data\n");
    const selectedRoot = makeConfRoot("userDataRoot: /overlay/data\n");
    const roots = resolveLandoRoots({
      platform: "linux",
      home,
      env: {
        LANDO_USER_CONF_ROOT: ignoredRoot,
        LANDO_CONFIG__user_conf_root: selectedRoot,
      },
    });
    expect(roots.userConfRoot).toBe(selectedRoot);
    expect(roots.userDataRoot).toBe("/overlay/data");
  });

  test("explicit userConfRoot override wins over env-overlay conf root", () => {
    const explicitRoot = makeConfRoot("userDataRoot: /explicit/data\n");
    const overlayRoot = makeConfRoot("userDataRoot: /overlay/data\n");
    const roots = resolveLandoRoots({
      platform: "linux",
      home,
      userConfRoot: explicitRoot,
      env: { LANDO_CONFIG__user_conf_root: overlayRoot },
    });
    expect(roots.userConfRoot).toBe(explicitRoot);
    expect(roots.userDataRoot).toBe("/explicit/data");
  });

  test("conf root resolves from platform default when no override/env is set, even with config userConfRoot", () => {
    // No env: conf root falls to platform default; the config.yml at the default
    // location is not present, so all roots fall to defaults. We assert the conf
    // root is the default (config self-reference cannot move it).
    const roots = resolveLandoRoots({ platform: "linux", home, env: noEnv });
    expect(roots.userConfRoot).toBe("/home/tester/.config/lando");
  });
});

describe("env short-circuit keeps the fast path IO-free", () => {
  test("conf/data/cache do not read config.yml when their LANDO_* env is set", () => {
    // Point conf root at a directory whose config.yml would throw if parsed
    // (malformed). If the resolver short-circuits on env for data/cache, the
    // malformed file is never read for those roots.
    const confRoot = makeConfRoot("userDataRoot: [this is not valid yaml subset");
    const roots = resolveLandoRoots({
      platform: "linux",
      home: "/home/tester",
      env: {
        LANDO_USER_CONF_ROOT: confRoot,
        LANDO_USER_DATA_ROOT: "/env/data",
        LANDO_USER_CACHE_ROOT: "/env/cache",
      },
    });
    expect(roots.userDataRoot).toBe("/env/data");
    expect(roots.userCacheRoot).toBe("/env/cache");
  });
});

describe("makeLandoPaths derived builders (§12)", () => {
  const home = "/home/tester";
  const linux = (env: Record<string, string | undefined> = noEnv): RootOverrides => ({
    platform: "linux",
    home,
    env,
  });

  test("returns resolved roots and active platform", () => {
    const paths = makeLandoPaths(linux());
    expect(paths.platform).toBe("linux");
    expect(paths.roots.userDataRoot).toBe("/home/tester/.local/share/lando");
  });

  test("userData-scoped builders", () => {
    const paths = makeLandoPaths(linux());
    const data = "/home/tester/.local/share/lando";
    expect(paths.pluginsDir).toBe(join(data, "plugins"));
    expect(paths.appPluginsDir("acme")).toBe(join(data, "apps", "acme", "plugins"));
    expect(paths.pluginAuthFile).toBe(join(data, "plugin-auth.json"));
    expect(paths.binDir).toBe(join(data, "bin"));
    expect(paths.keysDir).toBe(join(data, "keys"));
    expect(paths.certsDir).toBe(join(data, "certs"));
    expect(paths.runtimeDir).toBe(join(data, "runtime"));
    expect(paths.globalAppRoot).toBe(join(data, "global"));
  });

  test("userCache-scoped builders", () => {
    const paths = makeLandoPaths(linux());
    const cache = "/home/tester/.cache/lando";
    expect(paths.logsDir).toBe(join(cache, "logs"));
    expect(paths.scratchDir).toBe(join(cache, "scratch"));
    expect(paths.scratchRegistryFile).toBe(join(cache, "scratch", "registry.bin"));
    expect(paths.fileSyncSessionsDir).toBe(join(cache, "file-sync", "sessions"));
  });

  test("userConf-scoped builders", () => {
    const paths = makeLandoPaths(linux());
    const conf = "/home/tester/.config/lando";
    expect(paths.configDir).toBe(conf);
    expect(paths.configFile).toBe(join(conf, "config.yml"));
    expect(paths.globalConfigFile).toBe(join(conf, "global.config.yml"));
  });

  test("app-cache builders sanitize names and fingerprint the app root", () => {
    const paths = makeLandoPaths(linux());
    const cache = "/home/tester/.cache/lando";
    const dir = paths.appCacheDir("My App!", "/work/site-a");
    // Sanitized name ("My App!" -> "My-App") + 12-hex fingerprint, under <cache>/apps/.
    expect(dir.startsWith(`${join(cache, "apps")}/`)).toBe(true);
    expect(dir).toMatch(/\/apps\/My-App-[0-9a-f]{12}$/u);
    expect(paths.appPlanCacheFile("My App!", "/work/site-a")).toBe(join(dir, "plan.bin"));
  });

  test("app-cache avoids collisions for apps sharing a name in different roots", () => {
    const paths = makeLandoPaths(linux());
    const a = paths.appCacheDir("site", "/work/a");
    const b = paths.appCacheDir("site", "/work/b");
    expect(a).not.toBe(b);
    expect(paths.appPlanCacheFile("site", "/work/a")).not.toBe(paths.appPlanCacheFile("site", "/work/b"));
  });

  test("derived builders honor overridden roots", () => {
    const paths = makeLandoPaths({
      platform: "linux",
      home,
      env: noEnv,
      userDataRoot: "/iso/data",
      userCacheRoot: "/iso/cache",
      userConfRoot: "/iso/conf",
    });
    expect(paths.pluginsDir).toBe("/iso/data/plugins");
    expect(paths.scratchDir).toBe("/iso/cache/scratch");
    expect(paths.configFile).toBe("/iso/conf/config.yml");
  });

  test("win32 derived builders use backslash separators", () => {
    const paths = makeLandoPaths({
      platform: "win32",
      home: "C:\\Users\\tester",
      env: {
        APPDATA: "C:\\Users\\tester\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
        PROGRAMDATA: "C:\\ProgramData",
      },
    });
    expect(paths.pluginsDir).toBe("C:\\Users\\tester\\AppData\\Local\\Lando\\Data\\plugins");
    expect(paths.scratchRegistryFile).toBe(
      "C:\\Users\\tester\\AppData\\Local\\Lando\\Cache\\scratch\\registry.bin",
    );
  });
});
