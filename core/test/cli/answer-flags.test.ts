import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  AnswersFileError,
  mergeAnswerSources,
  parseAnswerFlags,
  parseAnswerSources,
  readAnswersFile,
  resolveInteractivityGate,
} from "../../src/cli/prompts/answer-flags.ts";

describe("answer-flags — answer sources", () => {
  test("mergeAnswerSources flattens repeatable flag lists, skipping undefined", () => {
    expect(mergeAnswerSources(["a=1"], undefined, ["b=2", "c=3"])).toEqual(["a=1", "b=2", "c=3"]);
  });

  test("parseAnswerFlags parses key=value entries", () => {
    expect(parseAnswerFlags(["app=blog", "region=us=east"])).toEqual({ app: "blog", region: "us=east" });
  });

  test("parseAnswerSources merges the scratch --option synonym into --answer (later wins)", () => {
    expect(parseAnswerSources(["app=blog"], ["app=store", "tier=free"])).toEqual({
      app: "store",
      tier: "free",
    });
  });
});

describe("answer-flags — answers file", () => {
  test("readAnswersFile reads a flat JSON object of strings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-af-"));
    const file = join(dir, "answers.json");
    await writeFile(file, JSON.stringify({ app: "blog", tier: "free" }), "utf8");
    expect(await readAnswersFile(file)).toEqual({ app: "blog", tier: "free" });
  });

  test("readAnswersFile rejects a non-object payload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-af-"));
    const file = join(dir, "answers.json");
    await writeFile(file, JSON.stringify(["not", "an", "object"]), "utf8");
    await expect(readAnswersFile(file)).rejects.toBeInstanceOf(AnswersFileError);
  });

  test("readAnswersFile rejects non-string values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-af-"));
    const file = join(dir, "answers.json");
    await writeFile(file, JSON.stringify({ app: 42 }), "utf8");
    await expect(readAnswersFile(file)).rejects.toBeInstanceOf(AnswersFileError);
  });
});

describe("answer-flags — interactivity gate", () => {
  test("--interactive forces interactive regardless of TTY", () => {
    expect(resolveInteractivityGate({ interactive: true, isTTY: false })).toEqual({
      yes: false,
      interactive: true,
      nonInteractive: false,
      mode: "interactive",
    });
  });

  test("--no-interactive forces non-interactive", () => {
    expect(resolveInteractivityGate({ noInteractive: true, isTTY: true })).toEqual({
      yes: false,
      interactive: false,
      nonInteractive: true,
      mode: "non-interactive",
    });
  });

  test("auto keys off TTY stdin", () => {
    expect(resolveInteractivityGate({ isTTY: true })).toEqual({
      yes: false,
      interactive: true,
      nonInteractive: false,
      mode: "auto",
    });
    expect(resolveInteractivityGate({ isTTY: false })).toEqual({
      yes: false,
      interactive: false,
      nonInteractive: true,
      mode: "auto",
    });
  });

  test("--yes is reported orthogonally to interactivity", () => {
    expect(resolveInteractivityGate({ yes: true, isTTY: false })).toMatchObject({ yes: true });
  });
});
