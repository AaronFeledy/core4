import { describe, expect, test } from "bun:test";

import { resolveCliRendererMode } from "../../src/cli/renderer-boundary.ts";

const env = (value?: string): Record<string, string | undefined> =>
  value === undefined ? {} : { LANDO_RENDERER: value };

describe("resolveCliRendererMode precedence", () => {
  test("flag beats env, config, and default", async () => {
    let configReads = 0;
    const resolution = await resolveCliRendererMode({
      argv: ["--renderer=plain", "start"],
      env: env("json"),
      loadConfigRenderer: async () => {
        configReads += 1;
        return "verbose";
      },
    });
    expect(resolution.mode).toBe("plain");
    expect(resolution.source).toBe("flag");
    expect(configReads).toBe(0);
  });

  test("env beats config and default when no flag", async () => {
    let configReads = 0;
    const resolution = await resolveCliRendererMode({
      argv: ["start"],
      env: env("json"),
      loadConfigRenderer: async () => {
        configReads += 1;
        return "verbose";
      },
    });
    expect(resolution.mode).toBe("json");
    expect(resolution.source).toBe("env");
    expect(configReads).toBe(0);
  });

  test("config is consulted only when flag and env are absent", async () => {
    let configReads = 0;
    const resolution = await resolveCliRendererMode({
      argv: ["start"],
      env: env(),
      loadConfigRenderer: async () => {
        configReads += 1;
        return "verbose";
      },
    });
    expect(resolution.mode).toBe("verbose");
    expect(resolution.source).toBe("config");
    expect(configReads).toBe(1);
  });

  test("falls back to default when nothing is set", async () => {
    const resolution = await resolveCliRendererMode({
      argv: ["start"],
      env: env(),
      loadConfigRenderer: async () => undefined,
    });
    expect(resolution.mode).toBe("lando");
    expect(resolution.source).toBe("default");
  });
});
