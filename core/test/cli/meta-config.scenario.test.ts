import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ConfigResultSchema, config } from "@lando/engine/operations/config";
import { GlobalConfigSources } from "@lando/engine/services/config";
import type { GlobalConfig } from "@lando/sdk/schema";
import { Effect, Layer, Schema } from "effect";

import { metaConfigSpec } from "../../src/cli/command-specs/meta/config.ts";
import { renderConfigResult } from "../../src/cli/commands/config.ts";
import { validateEventCommandInput } from "../../src/cli/event-command-input.ts";

const cliEntry = resolve(import.meta.dirname, "../../bin/lando.ts");

const runCli = async (
  args: ReadonlyArray<string>,
  cwd: string,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...args],
    env: { ...process.env },
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

const fakeConfigService = (overrides: typeof GlobalConfig.Encoded) => {
  return Layer.succeed(GlobalConfigSources, {
    env: { ...process.env },
    host: overrides,
    sources: { user: true, env: true },
  });
};

const withTempEnv = async <T>(vars: Record<string, string>, run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-meta-config-"));
  const touched = new Set<string>([
    "LANDO_USER_CONF_ROOT",
    "LANDO_USER_DATA_ROOT",
    "LANDO_USER_CACHE_ROOT",
    ...Object.keys(vars),
  ]);
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("LANDO_CONFIG__")) touched.add(name);
  }
  const previous = new Map<string, string | undefined>();
  for (const name of touched) previous.set(name, process.env[name]);
  try {
    for (const name of touched) delete process.env[name];
    process.env.LANDO_USER_CONF_ROOT = dir;
    process.env.LANDO_USER_DATA_ROOT = join(dir, "data");
    process.env.LANDO_USER_CACHE_ROOT = join(dir, "cache");
    for (const [name, value] of Object.entries(vars)) process.env[name] = value;
    return await run(dir);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
};

describe("meta:config command", () => {
  test("CLI repairs invalid config even when notify.commands selects meta:config", async () => {
    await withTempEnv({}, async (dir) => {
      await writeFile(
        join(dir, "config.yml"),
        'router:\n  httpPort: nonsense\nnotify:\n  commands: ["meta:config"]\n',
      );
      const result = await runCli(["config", "unset", "router.httpPort", "--format=json"], dir);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, result: { changed: true } });
      expect(await readFile(join(dir, "config.yml"), "utf8")).not.toContain("nonsense");
    });
  });
  test("CLI reports an external env issue as a warning after a successful repair", async () => {
    await withTempEnv({ LANDO_ROUTER_HTTPS_PORT: "99999" }, async (dir) => {
      await writeFile(join(dir, "config.yml"), "router:\n  httpPort: nonsense\n");
      const result = await runCli(["config", "unset", "router.httpPort", "--format=json"], dir);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        warnings: [
          {
            code: "LANDO_CONFIG_OTHER_SOURCE_INVALID",
            remediation: expect.stringContaining("LANDO_ROUTER_HTTPS_PORT"),
          },
        ],
      });
    });
  });
  test.each([{ args: [] }, { args: ["get", "router.httpPort"] }])(
    "CLI preserves config issues for read arguments $args",
    async ({ args }) => {
      await withTempEnv({}, async (dir) => {
        await writeFile(join(dir, "config.yml"), "router:\n  httpPort: 99999\n");
        const result = await runCli(["config", ...args, "--format=json"], dir);
        expect(result.exitCode).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: false,
          error: {
            _tag: "ConfigError",
            path: join(dir, "config.yml"),
            issues: [{ path: ["router", "httpPort"], message: expect.any(String) }],
            remediation: expect.stringContaining("lando config validate"),
          },
        });
      });
    },
  );
  test("encodes the resolved global config result faithfully", async () => {
    const result = await Effect.runPromise(
      config({ format: "json" }).pipe(
        Effect.provide(fakeConfigService({ userDataRoot: "/data", userConfRoot: "/conf" })),
      ),
    );
    const encoded = Schema.encodeSync(ConfigResultSchema)(result);
    expect(encoded).toMatchObject({
      config: { userDataRoot: "/data", userConfRoot: "/conf" },
      format: "json",
    });
  });

  test("supports dot-path lookups via --path", async () => {
    const result = await Effect.runPromise(
      config({ path: "userDataRoot", format: "json" }).pipe(
        Effect.provide(fakeConfigService({ userDataRoot: "/data" })),
      ),
    );
    expect(Schema.encodeSync(ConfigResultSchema)(result)).toMatchObject({
      key: "userDataRoot",
      value: "/data",
      format: "json",
    });
  });

  test("--path resolves bracket array indices the same way write paths do", async () => {
    const result = await Effect.runPromise(
      config({ path: "network.proxy.noProxy[1]", format: "json" }).pipe(
        Effect.provide(fakeConfigService({ network: { proxy: { noProxy: ["a", "b"] } } })),
      ),
    );
    expect(result.value).toBe("b");
  });

  test("get subcommand reads a single key", async () => {
    const result = await Effect.runPromise(
      config({ subcommand: "get", key: "userConfRoot", format: "table" }).pipe(
        Effect.provide(fakeConfigService({ userConfRoot: "/conf" })),
      ),
    );
    expect(renderConfigResult(result)).toContain("/conf");
  });

  test("set writes the global config atomically and reports changed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-meta-config-write-"));
    try {
      const path = join(dir, "config.yml");
      const result = await Effect.runPromise(
        config({ subcommand: "set", key: "renderer", value: "json", configPath: path }).pipe(
          Effect.provide(fakeConfigService({})),
        ),
      );
      expect(result.subcommand).toBe("set");
      expect(result.changed).toBe(true);
      expect(await readFile(path, "utf8")).toContain("renderer");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a malformed path is rejected with a tagged write-validation error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-meta-config-reject-"));
    try {
      const path = join(dir, "config.yml");
      const result = await Effect.runPromiseExit(
        config({ subcommand: "set", key: "", value: "bar", configPath: path }).pipe(
          Effect.provide(fakeConfigService({})),
        ),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        const cause = JSON.stringify(result.cause);
        expect(cause).toContain("LandofileWriteValidationError");
        expect(cause).toContain("remediation");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("event input rejects an undeclared config verb with a suggestion and choices", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        validateEventCommandInput(metaConfigSpec, {
          flags: {},
          args: { subcommand: "settt" },
          raw: [],
        }),
      ),
    );
    expect(error).toMatchObject({
      _tag: "CommandInputValidationError",
      target: "meta:config",
      field: "subcommand",
      kind: "arg",
      reason: "option",
      remediation:
        'Did you mean "set"? subcommand takes one of: view, get, set, unset, edit, validate, describe, telemetry, translate.',
    });
  });

  test.each([
    ["meta:config", "meta:config", "view, get, set, unset, edit, validate, describe, telemetry, translate"],
    ["global:config", "meta:global:config", "view, set, unset, edit, validate, describe"],
  ])(
    "CLI %s rejects a mistyped subcommand with exit 2",
    async (command, target, choices) => {
      const dir = await mkdtemp(join(tmpdir(), "lando-meta-config-cli-typo-"));
      try {
        const result = await runCli([command, "settt", "--format", "json"], dir);
        expect(result.exitCode).toBe(2);
        const envelope = JSON.parse(result.stdout) as {
          readonly ok?: boolean;
          readonly error?: { readonly message?: string };
        };
        expect(envelope.ok).toBe(false);
        expect(envelope.error?.message).toContain("subcommand");
        expect(JSON.parse(result.stdout).error).toMatchObject({
          _tag: "CommandInputValidationError",
          target,
          field: "subcommand",
          kind: "arg",
          reason: "option",
          remediation: `Did you mean "set"? subcommand takes one of: ${choices}.`,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    15000,
  );

  test.each(["config", "global:config", "app:config"])(
    "CLI %s rejects bad verbs before logging",
    async (command) => {
      await withTempEnv({}, async (dir) => {
        await writeFile(join(dir, "config.yml"), "router:\n  httpPort: nonsense\n");
        const result = await runCli([command, "valdiate", "--renderer=plain"], dir);
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("CommandInputValidationError");
        expect(result.stderr).toContain('Did you mean "validate"? subcommand takes one of:');
        expect(result.stderr).toContain("reason: option");
        expect(result.stderr).not.toContain("logsDir:");
        expect(result.stderr).not.toContain("cacheDir:");
      });
    },
  );

  test("CLI keeps translate accepted so its app-scoped remediation runs", async () => {
    await withTempEnv({}, async (dir) => {
      const result = await runCli(["config", "translate", "--format=json"], dir);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).error).toMatchObject({
        _tag: "NotImplementedError",
        remediation: expect.stringContaining("app-scoped"),
      });
    });
  });

  test.each(["resolved", "raw"] as const)(
    "CLI missing %s get has no value and empty human output",
    async (source) => {
      await withTempEnv({}, async (dir) => {
        const human = await runCli(["config", "get", "nope.nope", "--source", source], dir);
        expect(human.exitCode).toBe(0);
        expect(human.stdout).toBe("");
        const machine = await runCli(
          ["config", "get", "nope.nope", "--source", source, "--format=json"],
          dir,
        );
        expect(machine.exitCode).toBe(0);
        expect(JSON.parse(machine.stdout)).toMatchObject({
          ok: true,
          result: { subcommand: "get", key: "nope.nope", format: "json" },
        });
        expect(Object.keys(JSON.parse(machine.stdout).result).sort()).toEqual([
          "format",
          "key",
          "subcommand",
        ]);
      });
    },
    15000,
  );

  test.each([
    [undefined, ""],
    [null, "null"],
    [false, "false"],
    [0, "0"],
    ["hello", "hello"],
    [{ enabled: true }, "KEY      VALUE\nenabled  true"],
    [[1, 2], "1,2"],
  ])("renders a selected value %j explicitly", (value, expected) => {
    expect(
      renderConfigResult({
        subcommand: "get",
        key: "example",
        ...(value === undefined ? {} : { value }),
        format: "table",
      }),
    ).toBe(expected);
  });

  test("telemetry off writes telemetry.enabled false and reports the effective config source", async () => {
    await withTempEnv({}, async (dir) => {
      const result = await Effect.runPromise(
        config({ subcommand: "telemetry", key: "off", format: "json" }).pipe(
          Effect.provide(fakeConfigService({})),
        ),
      );

      expect(Schema.encodeSync(ConfigResultSchema)(result)).toMatchObject({
        telemetry: { enabled: false, source: "config" },
        changed: true,
        format: "json",
        configPath: join(dir, "config.yml"),
      });
      expect(await readFile(join(dir, "config.yml"), "utf8")).toContain("enabled: false");
    });
  });

  test("telemetry status reports env override ahead of config", async () => {
    await withTempEnv({ LANDO_CONFIG__TELEMETRY__ENABLED: "0" }, async (dir) => {
      await writeFile(join(dir, "config.yml"), "telemetry:\n  enabled: true\n");

      const result = await Effect.runPromise(
        config({ subcommand: "telemetry", key: "status", format: "json" }).pipe(
          Effect.provide(fakeConfigService({})),
        ),
      );

      expect(Schema.encodeSync(ConfigResultSchema)(result)).toMatchObject({
        telemetry: { enabled: false, source: "env" },
        changed: false,
        format: "json",
      });
    });
  });
});
