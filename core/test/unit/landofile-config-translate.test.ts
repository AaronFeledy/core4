import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { ConfigTranslateError, ConfigTranslatorConflictError } from "@lando/sdk/errors";
import type { AbsolutePath, LandofileShape } from "@lando/sdk/schema";
import type {
  ConfigTranslateDetectInput,
  ConfigTranslateInput,
  ConfigTranslateResult,
  ConfigTranslatorShape,
} from "@lando/sdk/services";

import {
  detectConfigTranslators,
  resolveConfigTranslators,
  runConfigTranslators,
} from "../../src/landofile/config-translate.ts";

const appRoot = "/tmp/app" as AbsolutePath;

const makeTranslator = (
  id: string,
  overrides: Partial<ConfigTranslatorShape> = {},
): ConfigTranslatorShape => ({
  id,
  summary: `${id} translator`,
  inputKinds: [id],
  detect: () => Effect.succeed([{ translator: id, files: [], confidence: "likely" as const }]),
  translate: () =>
    Effect.succeed<ConfigTranslateResult>({
      fragment: { name: id } as Partial<LandofileShape>,
      diagnostics: [{ kind: "generated", message: `${id} generated`, path: id }],
    }),
  ...overrides,
});

const baseInput: ConfigTranslateInput = {
  appRoot,
  files: [],
  current: { name: "app" } as LandofileShape,
  options: {},
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

describe("runConfigTranslators", () => {
  test("runs translators in declared order, aggregating diagnostics and ordered-merging fragments", async () => {
    const result = await Effect.runPromise(
      runConfigTranslators([makeTranslator("a"), makeTranslator("b")], baseInput),
    );
    // declared order: a then b -> b wins on shared `name` key
    expect(result.fragment).toEqual({ name: "b" });
    // diagnostics concatenated in declared order
    expect(result.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      "a generated",
      "b generated",
    ]);
  });

  test("propagates a translator's ConfigTranslateError", async () => {
    const failing = makeTranslator("x", {
      translate: () => Effect.fail(new ConfigTranslateError({ message: "boom", translator: "x" })),
    });
    const exit = await Effect.runPromiseExit(runConfigTranslators([failing], baseInput));
    expect(exit._tag).toBe("Failure");
  });

  test("surfaces the conflict before running any translator", async () => {
    let ran = false;
    const spy = makeTranslator("dup", {
      translate: () => {
        ran = true;
        return Effect.succeed<ConfigTranslateResult>({ fragment: {}, diagnostics: [] });
      },
    });
    const exit = await Effect.runPromiseExit(runConfigTranslators([spy, makeTranslator("dup")], baseInput));
    expect(exit._tag).toBe("Failure");
    expect(ran).toBe(false);
  });
});

describe("detectConfigTranslators", () => {
  test("aggregates detect matches in declared order", async () => {
    const detectInput: ConfigTranslateDetectInput = { appRoot };
    const matches = await Effect.runPromise(
      detectConfigTranslators([makeTranslator("a"), makeTranslator("b")], detectInput),
    );
    expect(matches.map((match) => match.translator)).toEqual(["a", "b"]);
  });
});
