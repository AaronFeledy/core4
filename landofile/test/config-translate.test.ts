import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { ConfigTranslateError, ConfigTranslatorConflictError } from "@lando/sdk/errors";
import { ConfigTranslateSourceId } from "@lando/sdk/schema";
import type {
  ConfigTranslateDetectInput,
  ConfigTranslateInput,
  ConfigTranslateResult,
  ConfigTranslatorShape,
} from "@lando/sdk/services";

import {
  detectConfigTranslators,
  resolveConfigTranslators,
  runConfigTranslator,
} from "../src/config-translate.ts";

const sourceId = ConfigTranslateSourceId.make("compose.yml");

const makeTranslator = (
  id: string,
  overrides: Partial<ConfigTranslatorShape> = {},
): ConfigTranslatorShape => ({
  id,
  summary: `${id} translator`,
  inputKinds: [id],
  detect: () => Effect.succeed([{ translator: id, sourceIds: [sourceId], confidence: "likely" as const }]),
  translate: () =>
    Effect.succeed<ConfigTranslateResult>({
      outputs: [{ targetLayer: "canonical", fragment: { name: id }, sourceIds: [sourceId] }],
      diagnostics: [{ kind: "generated", message: `${id} generated`, sourceId, keyPath: [] }],
      deletions: [],
    }),
  ...overrides,
});

const baseInput: ConfigTranslateInput = {
  _tag: "landofile-document-set",
  documents: [
    {
      sourceId,
      layerId: "canonical",
      mediaType: "application/yaml",
      contentDigest: `sha256:${"0".repeat(64)}`,
      bytes: new Uint8Array(),
    },
  ],
  mode: "full",
  selectedSourceIds: [sourceId],
  currentLowerV4Fragments: [],
  writableLayerIds: ["canonical"],
};

describe("resolveConfigTranslators", () => {
  test("preserves declared order for distinct ids (deterministic)", async () => {
    const resolved = await Effect.runPromise(
      resolveConfigTranslators([makeTranslator("a"), makeTranslator("b"), makeTranslator("c")]),
    );
    expect(resolved.map((translator) => translator.id)).toEqual(["a", "b", "c"]);
  });

  test("empty input resolves to empty list", async () => {
    const resolved = await Effect.runPromise(resolveConfigTranslators([]));
    expect(resolved).toEqual([]);
  });

  test("duplicate id fails with ConfigTranslatorConflictError", async () => {
    const exit = await Effect.runPromiseExit(
      resolveConfigTranslators([makeTranslator("a"), makeTranslator("lando-v3"), makeTranslator("lando-v3")]),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") throw new Error("expected failure");
    const error = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
    expect(error).toBeInstanceOf(ConfigTranslatorConflictError);
    expect((error as ConfigTranslatorConflictError).id).toBe("lando-v3");
    expect((error as ConfigTranslatorConflictError).translators).toHaveLength(2);
  });
});

describe("runConfigTranslator", () => {
  test("returns validated outputs when the translator respects input ownership", async () => {
    const result = await Effect.runPromise(runConfigTranslator(makeTranslator("a"), baseInput));
    expect(result.outputs[0]?.fragment).toEqual({ name: "a" });
    expect(result.diagnostics.map((diagnostic) => diagnostic.message)).toEqual(["a generated"]);
  });

  test("propagates a translator's ConfigTranslateError", async () => {
    const failing = makeTranslator("x", {
      translate: () => Effect.fail(new ConfigTranslateError({ message: "boom", translator: "x" })),
    });
    const exit = await Effect.runPromiseExit(runConfigTranslator(failing, baseInput));
    expect(exit._tag).toBe("Failure");
  });

  test("rejects invalid input before running the translator", async () => {
    let ran = false;
    const spy = makeTranslator("dup", {
      translate: () => {
        ran = true;
        return Effect.succeed<ConfigTranslateResult>({ outputs: [], diagnostics: [], deletions: [] });
      },
    });
    const exit = await Effect.runPromiseExit(
      runConfigTranslator(spy, { ...baseInput, writableLayerIds: [] }),
    );
    expect(exit._tag).toBe("Failure");
    expect(ran).toBe(false);
  });
});

describe("detectConfigTranslators", () => {
  test("aggregates detect matches in declared order", async () => {
    const detectInput: ConfigTranslateDetectInput = { documents: baseInput.documents };
    const matches = await Effect.runPromise(
      detectConfigTranslators([makeTranslator("a"), makeTranslator("b")], detectInput),
    );
    expect(matches.map((match) => match.translator)).toEqual(["a", "b"]);
  });
});

test("rejects foreign output source identities with producing translator attribution", async () => {
  const translator = makeTranslator("foreign", {
    translate: () =>
      Effect.succeed({
        outputs: [
          { targetLayer: "canonical", fragment: {}, sourceIds: [ConfigTranslateSourceId.make("other")] },
        ],
        diagnostics: [],
        deletions: [],
      }),
  });
  const result = await Effect.runPromise(Effect.either(runConfigTranslator(translator, baseInput)));
  expect(result._tag).toBe("Left");
  if (result._tag === "Left") expect(result.left.translator).toBe("foreign");
});

test.each(["source", "translator"])("rejects a detection match with foreign %s identity", async (kind) => {
  const translator = makeTranslator("a", {
    detect: () =>
      Effect.succeed([
        {
          translator: kind === "translator" ? "other" : "a",
          sourceIds: [kind === "source" ? ConfigTranslateSourceId.make("other") : sourceId],
          confidence: "exact",
        },
      ]),
  });
  const result = await Effect.runPromise(
    Effect.either(detectConfigTranslators([translator], { documents: baseInput.documents })),
  );
  expect(result._tag).toBe("Left");
  if (result._tag === "Left")
    expect(result.left).toMatchObject({ _tag: "ConfigTranslateError", translator: "a" });
});
