import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect);

describe("meta config set (S4)", () => {
  test("writes a scalar to config.yml", async () => {
    const result = await run(
      config({ subcommand: "set", key: "renderer", value: "json", configPath: configPath() }),
    );
    expect(result.subcommand).toBe("set");
    expect(result.changed).toBe(true);
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
    const exit = await Effect.runPromiseExit(
      config({
        subcommand: "set",
        key: "telemetry.enabled",
        value: "notbool",
        type: "string",
        configPath: configPath(),
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain("LandofileWriteValidationError");
    expect(await readConfig()).toBe(before);
  });
});

describe("meta config unset", () => {
  test("removes a key", async () => {
    await run(config({ subcommand: "set", key: "renderer", value: "json", configPath: configPath() }));
    const result = await run(config({ subcommand: "unset", key: "renderer", configPath: configPath() }));
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
    const exit = await Effect.runPromiseExit(config({ subcommand: "validate", configPath: configPath() }));
    expect(Exit.isFailure(exit)).toBe(true);
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
    const exit = await Effect.runPromiseExit(
      config({
        subcommand: "edit",
        configPath: configPath(),
        editorRunner: runner(() => "telemetry:\n  enabled: notbool\n"),
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(await readConfig()).toBe(before);
  });
});
