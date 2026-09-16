import { Effect, Match, Predicate, Schema } from "effect";
import { parseLandofile } from "../landofile/index.ts";
import type { ConfigTranslateResult } from "../schema/config-translate.ts";
import {
  LandofileAuthoringFragment,
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

const merge = (lower: unknown, upper: unknown): unknown => {
  if (!Predicate.isRecord(lower) || !Predicate.isRecord(upper)) return upper;
  return Object.fromEntries(
    [...new Set([...Object.keys(lower), ...Object.keys(upper)])].map((key) => [
      key,
      Object.hasOwn(upper, key) ? merge(lower[key], upper[key]) : lower[key],
    ]),
  );
};
const layers = { base: 0, dist: 1, upstream: 2, canonical: 3, local: 4, user: 5 } as const;
const onlyFragmentKeys = (emitted: unknown, fragment: unknown): boolean => {
  if (Array.isArray(emitted) && Array.isArray(fragment))
    return emitted.every((item, index) => onlyFragmentKeys(item, fragment[index]));
  if (!Predicate.isRecord(emitted)) return true;
  return (
    Predicate.isRecord(fragment) &&
    Object.keys(emitted).every(
      (key) => Object.hasOwn(fragment, key) && onlyFragmentKeys(emitted[key], fragment[key]),
    )
  );
};

export const checkAuthoringLaws = (
  harness: ConfigTranslatorContractHarness,
  result: ConfigTranslateResult,
  stableJson: (value: unknown) => string,
) =>
  Effect.gen(function* () {
    const lower = Match.value(harness.translateInput).pipe(
      Match.tag("recipe-request", () => []),
      Match.tag("landofile-document-set", ({ currentLowerV4Fragments }) => currentLowerV4Fragments),
      Match.exhaustive,
    );
    const fragments = [
      ...[...lower].sort((a, b) => layers[a.layerId] - layers[b.layerId]),
      ...[...result.outputs].sort((a, b) => layers[a.targetLayer] - layers[b.targetLayer]),
    ];
    let cumulative: unknown = {};
    for (const { fragment } of fragments) {
      cumulative = merge(cumulative, fragment);
      yield* Schema.decodeUnknown(LandofileAuthoringFragment)(cumulative, { onExcessProperty: "error" });
    }
    yield* Schema.decodeUnknown(LandofileAuthoringShape)(cumulative, { onExcessProperty: "error" });
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
          ? Schema.decodeUnknown(LandofileAuthoringShape)
          : Schema.decodeUnknown(LandofileAuthoringFragment);
      const actual = yield* decode(wire, { onExcessProperty: "error" });
      const expected = yield* decode(sample.fragment ?? sample.context, {
        onExcessProperty: "error",
      });
      if (
        stableJson(actual) !== stableJson(expected) ||
        (sample.fragment !== undefined && !onlyFragmentKeys(wire, sample.fragment))
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
