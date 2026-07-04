import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Layer, Schema } from "effect";

import { ConfigService } from "@lando/sdk/services";

import { ConfigResultSchema, config, renderConfigResult } from "../../src/cli/commands/config.ts";

const cliEntry = resolve(import.meta.dirname, "../../bin/lando.ts");

const runCli = async (
  args: ReadonlyArray<string>,
  cwd: string,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...args],
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

const fakeConfigService = (overrides: Partial<{ userDataRoot: string; userConfRoot: string }>) =>
  Layer.succeed(ConfigService, {
    get: <K extends string>(key: K) =>
      Effect.succeed((overrides as Record<string, unknown>)[key as string] as never),
    load: Effect.succeed({} as never),
  } as never);

const withTempEnv = async <T>(vars: Record<string, string>, run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-meta-config-"));
  const touched = new Set<string>(["LANDO_USER_CONF_ROOT", ...Object.keys(vars)]);
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("LANDO_CONFIG__")) touched.add(name);
  }
  const previous = new Map<string, string | undefined>();
  for (const name of touched) previous.set(name, process.env[name]);
  try {
    for (const name of touched) delete process.env[name];
    process.env.LANDO_USER_CONF_ROOT = dir;
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
      config({ path: "userDataRoot[1]", format: "json" }).pipe(
        Effect.provide(fakeConfigService({ userDataRoot: ["a", "b"] as never })),
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

  test("rejects an unrecognized subcommand instead of silently defaulting to view", async () => {
    const result = await Effect.runPromiseExit(
      config({ subcommand: "settt" as never }).pipe(Effect.provide(fakeConfigService({}))),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      const cause = JSON.stringify(result.cause);
      expect(cause).toContain("LandofileWriteValidationError");
      expect(cause).toContain("settt");
      expect(cause).toContain("remediation");
    }
  });

  test("CLI rejects a mistyped subcommand instead of succeeding as a view", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-meta-config-cli-typo-"));
    try {
      const result = await runCli(["meta:config", "settt", "--format", "json"], dir);
      expect(result.exitCode).not.toBe(0);
      const envelope = JSON.parse(result.stdout) as {
        readonly ok?: boolean;
        readonly error?: { readonly message?: string };
      };
      expect(envelope.ok).toBe(false);
      expect(envelope.error?.message).toContain("settt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
      await mkdir(dir, { recursive: true });
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
