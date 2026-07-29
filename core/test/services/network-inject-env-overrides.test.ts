import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";

import { ConfigError } from "@lando/core/errors";
import { ConfigService } from "@lando/core/services";
import { ConfigServiceLive } from "../../src/services/config.ts";

const ENV_NAMES = [
  "LANDO_USER_CONF_ROOT",
  "LANDO_NETWORK_CA_CERTS",
  "LANDO_NETWORK_CA_INJECT_INTO_SERVICES",
  "LANDO_NETWORK_PROXY_INJECT_INTO_SERVICES",
] as const;

const withEnv = async <T>(vars: Record<string, string>, body: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-network-inject-overrides-"));
  const previous = new Map<string, string | undefined>();
  for (const name of ENV_NAMES) previous.set(name, process.env[name]);
  try {
    for (const name of ENV_NAMES) Reflect.deleteProperty(process.env, name);
    process.env.LANDO_USER_CONF_ROOT = dir;
    for (const [name, value] of Object.entries(vars)) process.env[name] = value;
    return await body(dir);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
};

const writeConfig = (dir: string, lines: ReadonlyArray<string>): Promise<void> =>
  writeFile(join(dir, "config.yml"), [...lines, ""].join("\n"));

const loadConfig = () =>
  Effect.runPromise(
    Effect.flatMap(ConfigService, (configService) => configService.load).pipe(
      Effect.provide(ConfigServiceLive),
    ),
  );

describe("network inject environment overrides", () => {
  test("canonical aliases map booleans to typed network config", async () => {
    await withEnv(
      {
        LANDO_NETWORK_CA_INJECT_INTO_SERVICES: "false",
        LANDO_NETWORK_PROXY_INJECT_INTO_SERVICES: "true",
      },
      async (dir) => {
        await writeConfig(dir, [
          "network:",
          "  ca:",
          "    injectIntoServices: true",
          "  proxy:",
          "    injectIntoServices: false",
        ]);

        const config = await loadConfig();

        expect(config.network?.ca?.injectIntoServices).toBe(false);
        expect(config.network?.proxy?.injectIntoServices).toBe(true);
      },
    );
  });

  test("absent canonical aliases leave config.yml inject values intact", async () => {
    await withEnv({}, async (dir) => {
      await writeConfig(dir, [
        "network:",
        "  ca:",
        "    injectIntoServices: false",
        "  proxy:",
        "    injectIntoServices: true",
      ]);

      const config = await loadConfig();

      expect(config.network?.ca?.injectIntoServices).toBe(false);
      expect(config.network?.proxy?.injectIntoServices).toBe(true);
    });
  });

  for (const name of [
    "LANDO_NETWORK_CA_INJECT_INTO_SERVICES",
    "LANDO_NETWORK_PROXY_INJECT_INTO_SERVICES",
  ] as const) {
    test(`${name} rejects a malformed boolean`, async () => {
      await withEnv({ [name]: "sometimes" }, async () => {
        const exit = await Effect.runPromiseExit(
          Effect.flatMap(ConfigService, (configService) => configService.load).pipe(
            Effect.provide(ConfigServiceLive),
          ),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const failure = Cause.failureOption(exit.cause);
          expect(failure._tag).toBe("Some");
          if (failure._tag === "Some") expect(failure.value).toBeInstanceOf(ConfigError);
        }
      });
    });
  }

  test("LANDO_NETWORK_CA_CERTS remains outside the config overlay", async () => {
    await withEnv({ LANDO_NETWORK_CA_CERTS: '["/env.pem"]' }, async (dir) => {
      await writeConfig(dir, ["network:", "  ca:", '    certs: ["/file.pem"]']);

      const config = await loadConfig();

      expect(config.network?.ca?.certs).toEqual(["/file.pem"]);
    });
  });
});
