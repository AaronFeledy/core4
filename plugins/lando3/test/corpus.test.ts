import { expect, test } from "bun:test";
import { decodeLandofileAuthoringLayer, mergeLandofiles, parseLegacyLandofile } from "@lando/sdk/landofile";
import { LandofileAuthoringFragment, LandofileAuthoringFragmentNative } from "@lando/sdk/schema";
import { Effect, Result, Schema } from "effect";
import { isResidualDiagnostic } from "../src/claims.ts";
import { sourceLayerForDocument } from "../src/detect.ts";
import { occurrencesAt, toMergedValue } from "../src/legacy-merge.ts";
import expectations from "./fixtures/corpus-expectations.json";
import { corpusSets, readCorpusInput } from "./fixtures/corpus-input.ts";
import { makeTestTranslator } from "./fixtures/test-ports.ts";

const translator = makeTestTranslator();

test.each(corpusSets)(
  "translates the $id document set deterministically through strict boundaries",
  async (set) => {
    // Given: one directory, ordered using the production source-layer detector.
    const input = await readCorpusInput(set);
    const rejection = expectations.rejections.find(
      (entry: { readonly fixture: string }) => entry.fixture === set.id,
    );
    // When
    const first = await Effect.runPromise(translator.translate(input).pipe(Effect.result));
    const second = await Effect.runPromise(translator.translate(input).pipe(Effect.result));
    // Then: exact rejection matching also fails when a known rejection disappears.
    expect(second).toEqual(first);
    if (Result.isFailure(first)) {
      expect(rejection).toEqual({
        fixture: set.id,
        stage: "translate",
        tag: first.failure._tag,
        reason: first.failure.message,
      });
      return;
    }
    expect(rejection).toBeUndefined();
    const result = first.success;
    let prefix: Readonly<Record<string, unknown>> = {};
    for (const output of result.outputs) {
      const fragment = Schema.decodeUnknownSync(LandofileAuthoringFragment)(output.fragment, {
        onExcessProperty: "error",
      });
      const native = Schema.encodeSync(LandofileAuthoringFragmentNative)(fragment, {
        onExcessProperty: "error",
      });
      const decoded = await Effect.runPromise(decodeLandofileAuthoringLayer(output.targetLayer, native));
      prefix = mergeLandofiles([prefix, decoded]);
      await Effect.runPromise(decodeLandofileAuthoringLayer(output.targetLayer, prefix));
    }
    const sources = await Promise.all(
      input.documents.map(async (document) => {
        const parsed = await Effect.runPromise(
          parseLegacyLandofile({
            mode: "legacy",
            file: document.path ?? "",
            content: new TextDecoder().decode(document.bytes),
          }),
        );
        return {
          sourceId: document.sourceId,
          value: toMergedValue({
            document: parsed,
            sourceId: document.sourceId,
            layer: sourceLayerForDocument(document),
          }),
        };
      }),
    );
    const missing = [];
    for (const diagnostic of result.diagnostics) {
      const source = sources.find(({ sourceId }) => sourceId === diagnostic.sourceId);
      expect(source, `${set.id}: ${diagnostic.message}`).toBeDefined();
      if (
        source &&
        occurrencesAt(source.value, diagnostic.keyPath).some(({ span }) => span !== undefined) &&
        diagnostic.span === undefined
      ) {
        missing.push({
          sourceId: diagnostic.sourceId,
          keyPath: diagnostic.keyPath,
          kind: diagnostic.kind,
          message: diagnostic.message,
        });
      }
    }
    expect(missing).toEqual([]);
    expect(result.diagnostics.filter(isResidualDiagnostic)).toEqual([]);
  },
);

test("keeps every translation rejection attached to a tested document set", () => {
  // Given
  const ids = new Set(corpusSets.map(({ id }) => id));
  // When
  const fixtures = expectations.rejections.map((entry: { readonly fixture: string }) => entry.fixture);
  // Then
  expect(new Set(fixtures).size).toBe(fixtures.length);
  for (const fixture of fixtures) expect(ids.has(fixture)).toBe(true);
});
