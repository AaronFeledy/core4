import { Effect, Match, Predicate, Schema } from "effect";
import { mergeLandofiles, parseLandofile } from "../landofile/index.ts";
import type { ConfigTranslateResult } from "../schema/config-translate.ts";
import {
  LandofileAuthoringFragment,
  LandofileAuthoringFragmentNative,
  type LandofileAuthoringFragmentWire,
  LandofileAuthoringShape,
  type LandofileAuthoringShapeWire,
} from "../schema/landofile-authoring.ts";
import { ContractFailure } from "./_shared.ts";
import type { ConfigTranslatorContractHarness } from "./config-translator-route-filter.ts";

export interface ConfigTranslatorEncodeSample {
  readonly context: typeof LandofileAuthoringShapeWire.Type;
  readonly fragment?: typeof LandofileAuthoringFragmentWire.Type;
}

const layers = { base: 0, dist: 1, upstream: 2, canonical: 3, local: 4, user: 5 } as const;
const onlyFragmentKeys = (emitted: unknown, fragment: unknown): boolean => {
  if (Array.isArray(emitted) && Array.isArray(fragment))
    return emitted.every((item, index) => onlyFragmentKeys(item, fragment[index]));
  if (!Predicate.isObject(emitted)) return true;
  return (
    Predicate.isObject(fragment) &&
    Object.keys(emitted).every(
      (key) => Object.hasOwn(fragment, key) && onlyFragmentKeys(emitted[key], fragment[key]),
    )
  );
};

export const checkAuthoringLaws: (
  harness: ConfigTranslatorContractHarness,
  result: ConfigTranslateResult,
  stableJson: (value: unknown) => string,
) => Effect.Effect<void, unknown> = Effect.fnUntraced(function* (
  harness: ConfigTranslatorContractHarness,
  result: ConfigTranslateResult,
  stableJson: (value: unknown) => string,
): Effect.fn.Return<void, unknown> {
  const lower = Match.value(harness.translateInput).pipe(
    Match.tag("recipe-request", () => []),
    Match.tag("landofile-document-set", ({ currentLowerV4Fragments }) => currentLowerV4Fragments),
    Match.exhaustive,
  );
  const fragments = [
    ...[...lower].sort((a, b) => layers[a.layerId] - layers[b.layerId]),
    ...[...result.outputs].sort((a, b) => layers[a.targetLayer] - layers[b.targetLayer]),
  ];
  let cumulative: Record<string, unknown> = {};
  for (const { fragment } of fragments) {
    const decoded = yield* Schema.decodeUnknownEffect(LandofileAuthoringFragment)(fragment, {
      onExcessProperty: "error",
    });
    const native = yield* Schema.encodeEffect(LandofileAuthoringFragmentNative)(decoded, {
      onExcessProperty: "error",
    });
    if (!Predicate.isObject(native))
      return yield* Effect.fail(
        new ContractFailure({ message: "A fragment must be a mapping.", assertion: "fragment mapping" }),
      );
    cumulative = mergeLandofiles([cumulative, native]);
    yield* Schema.decodeUnknownEffect(LandofileAuthoringFragment)(cumulative, {
      onExcessProperty: "error",
    });
  }
  yield* Schema.decodeUnknownEffect(LandofileAuthoringShape)(cumulative, { onExcessProperty: "error" });
  const encode = harness.translator.encode;
  if (encode === undefined) return;
  const samples = harness.encodeSamples;
  if (samples === undefined || samples.length === 0)
    return yield* Effect.fail(
      new ContractFailure({
        message: "Encoder requires nonempty encodeSamples.",
        assertion: "encoder samples",
      }),
    );
  const decodeAuthoring =
    harness.decodeAuthoring ??
    ((text: string) => parseLandofile({ file: "lando.yml", content: text, cwd: "/" }));
  for (const sample of samples) {
    const emitted = yield* encode(sample);
    const wire = yield* decodeAuthoring(emitted.text);
    const decode =
      sample.fragment === undefined
        ? Schema.decodeUnknownEffect(LandofileAuthoringShape)
        : Schema.decodeUnknownEffect(LandofileAuthoringFragment);
    const actual = yield* Schema.decodeUnknownEffect(LandofileAuthoringFragmentNative)(wire, {
      onExcessProperty: "error",
    });
    const expected = yield* decode(sample.fragment ?? sample.context, {
      onExcessProperty: "error",
    });
    const actualWire = yield* Schema.encodeEffect(LandofileAuthoringFragment)(actual, {
      onExcessProperty: "error",
    });
    const expectedWire = yield* Schema.encodeUnknownEffect(LandofileAuthoringFragment)(expected, {
      onExcessProperty: "error",
    });
    if (
      stableJson(actualWire) !== stableJson(expectedWire) ||
      (sample.fragment !== undefined && !onlyFragmentKeys(actualWire, sample.fragment))
    ) {
      return yield* Effect.fail(
        new ContractFailure({
          message: "Encoder must preserve canonical authoring values and emit only the requested fragment.",
          assertion: "authoring encoder round trip",
          details: { actual, expected },
        }),
      );
    }
  }
});
