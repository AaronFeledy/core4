import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { appConfigOptionsFromInput, appConfigSpec } from "../../../src/cli/command-specs/app/config";
import { appConfigEditSpec } from "../../../src/cli/command-specs/app/config/verbs";
import {
  globalConfigOptionsFromInput,
  metaGlobalConfigSpec,
} from "../../../src/cli/command-specs/meta/global/config";
import { metaGlobalConfigEditSpec } from "../../../src/cli/command-specs/meta/global/config-verbs";
import { globalConfigEdit } from "../../../src/cli/commands/meta/global-config";
import { flagDefinitionsForCommand } from "../../../src/cli/compiled-argv";
import { compiledCommandInputFromArgv } from "../../../src/cli/compiled-input";
import { validateCommandCliFlags } from "../../../src/cli/flag-value-validation";
import { globalConfigLayer } from "../../_support/global-config-layer";

describe("global config edit dry-run persistence", () => {
  let dir = "";
  const original = "# original\nname: global\nruntime: 4\n";
  const edited = "# edited\nname: global\nruntime: 4\nrouter:\n  httpPort: 8081\n";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lando-config-edit-dry-run-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test.each([true, false, undefined])("persists only when dryRun is not true (%s)", async (dryRun) => {
    // Given
    const filePath = join(dir, ".lando.yml");
    await Bun.write(filePath, original);

    // When
    const result = await Effect.runPromise(
      globalConfigEdit(
        {
          ...(dryRun === undefined ? {} : { dryRun }),
          editorRunner: async () => ({ kind: "edited", content: edited }),
        },
        filePath,
      ).pipe(Effect.provide(globalConfigLayer(dir))),
    );

    // Then
    expect({ content: await Bun.file(filePath).text(), result }).toEqual({
      content: dryRun === true ? original : edited,
      result: { subcommand: "edit", changed: true, valid: true, dryRun: dryRun === true, filePath },
    });
  });

  test("does not create a missing Landofile when dryRun is true", async () => {
    // Given
    const filePath = join(dir, ".lando.yml");

    // When
    const result = await Effect.runPromise(
      globalConfigEdit(
        { dryRun: true, editorRunner: async () => ({ kind: "edited", content: edited }) },
        filePath,
      ).pipe(Effect.provide(globalConfigLayer(dir))),
    );

    // Then
    expect({ exists: await Bun.file(filePath).exists(), dryRun: result.dryRun }).toEqual({
      exists: false,
      dryRun: true,
    });
  });

  test("rejects an invalid edited buffer when dryRun is true", async () => {
    // Given
    const filePath = join(dir, ".lando.yml");
    await Bun.write(filePath, original);

    // When
    const result = await Effect.runPromise(
      globalConfigEdit(
        {
          dryRun: true,
          editorRunner: async () => ({ kind: "edited", content: "name: global\nruntime: invalid\n" }),
        },
        filePath,
      ).pipe(Effect.result, Effect.provide(globalConfigLayer(dir))),
    );

    // Then
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "LandofileWriteValidationError" } });
    expect(await Bun.file(filePath).text()).toBe(original);
  });
});

describe("config edit dry-run CLI input", () => {
  for (const [spec, positionals, optionsFromInput] of [
    [appConfigSpec, ["edit"], appConfigOptionsFromInput],
    [appConfigEditSpec, [], appConfigOptionsFromInput],
    [metaGlobalConfigSpec, ["edit"], globalConfigOptionsFromInput],
    [metaGlobalConfigEditSpec, [], globalConfigOptionsFromInput],
  ] as const) {
    test(`${spec.id} accepts and forwards --dry-run with --editor`, () => {
      // Given
      const argv = [...positionals, "--dry-run", "--editor", "test-editor"];

      // When
      const error = validateCommandCliFlags({
        commandId: spec.id,
        argv,
        definitions: flagDefinitionsForCommand(spec),
        allowUnknownFlags: spec.strict === false,
      });
      const options = optionsFromInput(compiledCommandInputFromArgv(spec.id, argv));

      // Then
      expect(error).toBeUndefined();
      expect(options).toMatchObject({ dryRun: true, editor: "test-editor" });
    });
  }
});
