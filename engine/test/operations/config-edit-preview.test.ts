import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { config } from "../../src/operations/config.ts";
import { GlobalConfigSources } from "../../src/services/config.ts";

let dir = "";
const configPath = (): string => join(dir, "config.yml");
const original = "# Keep this comment\nrenderer: plain # chosen\n";
const edited = "# Keep this comment\nrenderer: json # chosen\n";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lando-config-edit-preview-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const run = <A, E>(effect: Effect.Effect<A, E, GlobalConfigSources>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(GlobalConfigSources, {
        env: {},
        sources: { user: true, env: false },
        rootOverrides: { userConfRoot: dir },
      }),
    ),
  );

describe("installation config edit preview", () => {
  test("preserves existing bytes when dryRun is true", async () => {
    // Given
    await writeFile(configPath(), original);
    const before = await readFile(configPath());
    // When
    const result = await run(
      config({
        subcommand: "edit",
        configPath: configPath(),
        dryRun: true,
        editorRunner: async ({ content }) => ({ kind: "edited", content: content.replace("plain", "json") }),
      }),
    );
    // Then
    expect(await readFile(configPath())).toEqual(before);
    expect(result).toMatchObject({ subcommand: "edit", changed: true, valid: true, dryRun: true });
  });

  test("leaves the config absent when dryRun is true", async () => {
    // Given
    const path = configPath();
    // When
    const result = await run(
      config({
        subcommand: "edit",
        configPath: path,
        dryRun: true,
        editorRunner: async () => ({ kind: "edited", content: edited }),
      }),
    );
    // Then
    expect(existsSync(path)).toBe(false);
    expect(result).toMatchObject({ changed: true, valid: true, dryRun: true });
  });

  test.each([
    ["invalid YAML", "renderer: [\n"],
    ["schema-invalid config", "telemetry:\n  enabled: notbool\n"],
  ])("rejects %s when dryRun is true", async (_label, content) => {
    // Given
    await writeFile(configPath(), original);
    // When
    const result = await run(
      config({
        subcommand: "edit",
        configPath: configPath(),
        dryRun: true,
        editorRunner: async () => ({ kind: "edited", content }),
      }).pipe(Effect.flip),
    );
    // Then
    expect(result).toMatchObject({ _tag: "LandofileWriteValidationError", file: configPath() });
    expect(await readFile(configPath(), "utf8")).toBe(original);
  });

  test.each([{}, { dryRun: false }])(
    "persists the edited bytes when preview is disabled: %j",
    async (options) => {
      // Given
      await writeFile(configPath(), original);
      // When
      const result = await run(
        config({
          ...options,
          subcommand: "edit",
          configPath: configPath(),
          editorRunner: async () => ({ kind: "edited", content: edited }),
        }),
      );
      // Then
      expect(await readFile(configPath(), "utf8")).toBe(edited);
      expect(result).toMatchObject({ changed: true, valid: true, dryRun: false });
    },
  );
});
