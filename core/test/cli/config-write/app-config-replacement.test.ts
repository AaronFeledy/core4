import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StateStore } from "@lando/sdk/services";
import { Cause, Effect, Exit } from "effect";
import { appConfigEdit, appConfigSet, appConfigUnset } from "../../../src/cli/commands/app-config.ts";
import { testStateStoreLayer } from "../../_support/landofile-layer.ts";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lando-config-replacement-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const file = () => join(dir, ".lando.yml");
const write = (name: string, content: string) => writeFile(join(dir, name), content);
const run = <A, E>(effect: Effect.Effect<A, E, StateStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(testStateStoreLayer)));
const exit = <A, E>(effect: Effect.Effect<A, E, StateStore>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(testStateStoreLayer)));
const tag = <A, E extends { readonly _tag: string }>(result: Exit.Exit<A, E>) =>
  Exit.isFailure(result)
    ? Cause.findErrorOption(result.cause).pipe((error) =>
        error._tag === "Some" ? error.value._tag : undefined,
      )
    : undefined;

describe("authored source replacement", () => {
  test("inherits required service fields from lower layers without persisting them", async () => {
    await write(
      ".lando.base.yml",
      "name: inherited\nservices:\n  web:\n    type: node:22\n    primary: true\n",
    );
    await write(".lando.yml", "services:\n  web:\n    environment:\n      MODE: old\n");
    const result = await run(appConfigSet({ cwd: dir, key: "services.web.environment.MODE", value: "new" }));
    expect(result.changed).toBe(true);
    expect(await readFile(file(), "utf8")).toBe("services:\n  web:\n    environment:\n      MODE: new\n");
  });

  test("inserts an absent canonical source before local rather than after it", async () => {
    await write(".lando.upstream.yml", "name: precedence\nservices:\n  web:\n    primary: true\n");
    await write(".lando.local.yml", "services:\n  web:\n    primary: wrong\n");
    const result = await exit(
      appConfigSet({ cwd: dir, key: "services.web.primary", value: "false", type: "boolean" }),
    );
    expect(tag(result)).toBe("LandofileWriteValidationError");
    expect(await Bun.file(file()).exists()).toBe(false);
  });

  test.each([false, true])(
    "permits unrelated writes despite invalid higher overlays (dry-run %s)",
    async (dryRun) => {
      // Given
      const original = "name: stable\n";
      await write(".lando.yml", original);
      await write(".lando.local.yml", "runtime: wrong\n");
      // When
      const result = await run(appConfigSet({ cwd: dir, key: "name", value: "changed", dryRun }));
      // Then
      expect(result.changed).toBe(true);
      expect(await readFile(file(), "utf8")).toBe(dryRun ? original : "name: changed\n");
    },
  );

  test("rejects invalid candidate values even when a higher layer masks them", async () => {
    await write(".lando.yml", "name: stable\n");
    await write(".lando.local.yml", "runtime: 4\n");
    const result = await exit(appConfigSet({ cwd: dir, key: "runtime", value: "invalid" }));
    expect(tag(result)).toBe("LandofileWriteValidationError");
    expect(await readFile(file(), "utf8")).toBe("name: stable\n");
  });

  test("validates an unchanged unset against the effective stack without creating a target", async () => {
    // Given
    await write(".lando.base.yml", "name: absent\n");
    await write(".lando.local.yml", "runtime: wrong\n");
    // When
    const result = await run(appConfigUnset({ cwd: dir, key: "recipe" }));
    // Then
    expect(result.changed).toBe(false);
    expect(await Bun.file(file()).exists()).toBe(false);
  });

  test("repairs malformed old YAML before parsing and writes the exact edited buffer", async () => {
    await write(".lando.yml", ":\n  - broken\n::::\n");
    const buffer = "# author comment\nname: repaired\nservices:\n  web:\n    primary: true\n";
    const result = await run(
      appConfigEdit({ cwd: dir, editorRunner: async () => ({ kind: "edited", content: buffer }) }),
    );
    expect(result.valid).toBe(true);
    expect(await readFile(file(), "utf8")).toBe(buffer);
  });

  test.each([false, true])(
    "rejects invalid edit buffers without touching old malformed bytes (dry-run %s)",
    async (dryRun) => {
      const original = ":\n  - broken\n::::\n";
      await write(".lando.yml", original);
      const result = await exit(
        appConfigEdit({
          cwd: dir,
          dryRun,
          editorRunner: async () => ({ kind: "edited", content: "runtime: invalid\n" }),
        }),
      );
      expect(tag(result)).toBe("LandofileWriteValidationError");
      expect(await readFile(file(), "utf8")).toBe(original);
    },
  );

  test("validates edit dry-run and leaves bytes unchanged", async () => {
    await write(".lando.yml", "name: stable\n");
    await run(
      appConfigEdit({
        cwd: dir,
        dryRun: true,
        editorRunner: async () => ({ kind: "edited", content: "name: changed\n" }),
      }),
    );
    expect(await readFile(file(), "utf8")).toBe("name: stable\n");
  });

  test("persists expressions and directives as authored rather than decoded defaults or ASTs", async () => {
    await write(
      ".lando.yml",
      'name: authored\nservices:\n  web:\n    primary: "{{ eq(1, 1) }}"\n    environment: !override\n      MODE: source\n',
    );
    await run(appConfigSet({ cwd: dir, key: "x-added", value: "yes" }));
    const content = await readFile(file(), "utf8");
    expect(content).toContain("{{ eq(1, 1) }}");
    expect(content).toContain("!override");
    expect(content).not.toContain("AuthoringExpression");
    expect(content).not.toContain("runtime:");
  });

  test("keeps the exact template directive and authored expression text", async () => {
    await write(".lando.yml", "template: none\nname: authored\n");
    const content =
      'template: none\n# retained\nname: authored\nservices:\n  web:\n    primary: "{{ eq(1, 1) }}"\n';
    await run(appConfigEdit({ cwd: dir, editorRunner: async () => ({ kind: "edited", content }) }));
    expect(await readFile(file(), "utf8")).toBe(content);
  });
});
