import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConfigService } from "@lando/sdk/services";
import { Effect, Exit } from "effect";

import { config } from "../../../src/cli/commands/config.ts";
import type { EditorRunner } from "../../../src/recipes/prompts/editor-command.ts";

let dir = "";
const configPath = (): string => join(dir, "config.yml");
const seed = (content: string): Promise<void> => writeFile(configPath(), content, "utf8");
const readConfig = (): Promise<string> => readFile(configPath(), "utf8");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lando-metacfg-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const configService = {
  load: Effect.die("unused"),
  get: () => Effect.die("unused"),
};
const run = <A, E>(effect: Effect.Effect<A, E, ConfigService>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provideService(ConfigService, configService)));
const exit = <A, E>(effect: Effect.Effect<A, E, ConfigService>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provideService(ConfigService, configService)));

describe("meta config set (S4)", () => {
  test("writes a scalar to config.yml", async () => {
    const result = await run(
      config({ subcommand: "set", key: "renderer", value: "json", configPath: configPath() }),
    );
    expect(result.subcommand).toBe("set");
    expect(result.changed).toBe(true);
    expect(await readConfig()).toContain("renderer");
  });

  test("--path is honored when no positional key is given", async () => {
    const result = await run(
      config({ subcommand: "set", path: "renderer", value: "json", configPath: configPath() }),
    );
    expect(result.key).toBe("renderer");
    expect(await readConfig()).toContain("renderer");
  });

  test("--dry-run does not create/modify the file", async () => {
    const result = await run(
      config({ subcommand: "set", key: "renderer", value: "json", configPath: configPath(), dryRun: true }),
    );
    expect(result.dryRun).toBe(true);
    expect(existsSync(configPath())).toBe(false);
  });

  test("schema-violating value is rejected, file untouched", async () => {
    await seed("renderer: json\n");
    const before = await readConfig();
    const result = await exit(
      config({
        subcommand: "set",
        key: "telemetry.enabled",
        value: "notbool",
        type: "string",
        configPath: configPath(),
      }),
    );
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) expect(result.cause.toString()).toContain("LandofileWriteValidationError");
    expect(await readConfig()).toBe(before);
  });

  test("array values written by set can be validated by the global config reader", async () => {
    await run(
      config({
        subcommand: "set",
        key: "network.proxy.noProxy",
        value: '["a.com","b.com"]',
        type: "json",
        configPath: configPath(),
      }),
    );
    const result = await run(config({ subcommand: "validate", configPath: configPath() }));
    expect(result.valid).toBe(true);
    expect(await readConfig()).toContain("- a.com");
  });

  test("serializer rejections fail as LandofileWriteValidationError, file untouched", async () => {
    await seed("renderer: json\n");
    const before = await readConfig();
    const result = await exit(
      config({
        subcommand: "set",
        key: "pluginConfig.badPlugin",
        value: '{"bad key":"x"}',
        type: "json",
        configPath: configPath(),
      }),
    );
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) expect(result.cause.toString()).toContain("LandofileWriteValidationError");
    expect(await readConfig()).toBe(before);
  });
});

describe("meta config agentEnv wildcard rejection (S2)", () => {
  test("set of a wildcard allow name fails with AgentEnvPatternError, file untouched", async () => {
    await seed("renderer: json\n");
    const before = await readConfig();
    const result = await exit(
      config({
        subcommand: "set",
        key: "agentEnv.allow",
        value: '["CLAUDE_*"]',
        type: "json",
        configPath: configPath(),
      }),
    );
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      const text = result.cause.toString();
      expect(text).toContain("AgentEnvPatternError");
      expect(text).toContain("CLAUDE_*");
    }
    expect(await readConfig()).toBe(before);
  });

  test("set of an exact allow name succeeds", async () => {
    const result = await run(
      config({
        subcommand: "set",
        key: "agentEnv.allow",
        value: '["FOO_TOKEN"]',
        type: "json",
        configPath: configPath(),
      }),
    );
    expect(result.changed).toBe(true);
    expect(await readConfig()).toContain("FOO_TOKEN");
  });

  test("validate rejects a hand-written wildcard deny name with AgentEnvPatternError", async () => {
    await seed("agentEnv:\n  deny:\n    - BAD*\n");
    const result = await exit(config({ subcommand: "validate", configPath: configPath() }));
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) expect(result.cause.toString()).toContain("AgentEnvPatternError");
  });
});

describe("meta config unset", () => {
  test("removes a key", async () => {
    await run(config({ subcommand: "set", key: "renderer", value: "json", configPath: configPath() }));
    const result = await run(config({ subcommand: "unset", key: "renderer", configPath: configPath() }));
    expect(result.changed).toBe(true);
    expect(await readConfig()).not.toContain("renderer");
  });

  test("--path is honored when no positional key is given", async () => {
    await run(config({ subcommand: "set", key: "renderer", value: "json", configPath: configPath() }));
    const result = await run(config({ subcommand: "unset", path: "renderer", configPath: configPath() }));
    expect(result.changed).toBe(true);
    expect(await readConfig()).not.toContain("renderer");
  });
});

describe("meta config validate", () => {
  test("valid config returns valid:true", async () => {
    await seed("renderer: json\n");
    const result = await run(config({ subcommand: "validate", configPath: configPath() }));
    expect(result.valid).toBe(true);
  });

  test("invalid config fails with issues", async () => {
    await seed("telemetry:\n  enabled: notbool\n");
    const result = await exit(config({ subcommand: "validate", configPath: configPath() }));
    expect(Exit.isFailure(result)).toBe(true);
  });
});

describe("meta config edit via injected editor seam", () => {
  const runner =
    (transform: (content: string) => string): EditorRunner =>
    async ({ content }) => ({ kind: "edited", content: transform(content) });

  test("saves an edited valid config", async () => {
    await seed("renderer: json\n");
    const result = await run(
      config({
        subcommand: "edit",
        configPath: configPath(),
        editorRunner: runner((c) => `${c}defaultProviderId: null\n`),
      }),
    );
    expect(result.changed).toBe(true);
    expect(await readConfig()).toContain("defaultProviderId");
  });

  test("rejects an invalid edit, file untouched", async () => {
    await seed("renderer: json\n");
    const before = await readConfig();
    const result = await exit(
      config({
        subcommand: "edit",
        configPath: configPath(),
        editorRunner: runner(() => "telemetry:\n  enabled: notbool\n"),
      }),
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(await readConfig()).toBe(before);
  });
});
