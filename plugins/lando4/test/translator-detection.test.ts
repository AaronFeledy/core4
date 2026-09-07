import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { ConfigTranslateSourceId } from "@lando/sdk/schema";

import { lando4ConfigTranslator } from "../src/translator.ts";
import { LEGACY, LOCAL, canonicalOnly, makeDetectInput } from "./lando4-translator-fixtures.ts";

describe("lando4 detection", () => {
  test("is exact for a document set carrying the v4 runtime marker", async () => {
    const matches = await Effect.runPromise(lando4ConfigTranslator.detect(makeDetectInput(canonicalOnly)));
    expect(matches).toHaveLength(1);
    expect(matches[0]?.translator).toBe("lando4");
    expect(matches[0]?.confidence).toBe("exact");
    expect(matches[0]?.sourceIds).toEqual([ConfigTranslateSourceId.make(".lando.yml")]);
  });

  test("is likely for markerless canonical v4 documents", async () => {
    const matches = await Effect.runPromise(
      lando4ConfigTranslator.detect(
        makeDetectInput([{ path: ".lando.local.yml", layerId: "local", content: LOCAL }]),
      ),
    );
    expect(matches[0]?.confidence).toBe("likely");
  });

  test("never matches a Lando 3 document", async () => {
    const matches = await Effect.runPromise(
      lando4ConfigTranslator.detect(
        makeDetectInput([{ path: ".lando.yml", layerId: "canonical", content: LEGACY }]),
      ),
    );
    expect(matches).toEqual([]);
  });

  test("never matches without a YAML candidate", async () => {
    expect(await Effect.runPromise(lando4ConfigTranslator.detect(makeDetectInput([])))).toEqual([]);
  });

  test("is deterministic across repeated runs", async () => {
    const input = makeDetectInput(canonicalOnly);
    const first = await Effect.runPromise(lando4ConfigTranslator.detect(input));
    const second = await Effect.runPromise(lando4ConfigTranslator.detect(input));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
