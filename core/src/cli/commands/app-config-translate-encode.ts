import { landofileLayerPaths } from "@lando/landofile/layers";
import { mergeLandofiles } from "@lando/landofile/merge";
import { rejectUnsupportedToolingFeatures } from "@lando/landofile/tooling-unsupported";
import { ConfigTranslateError } from "@lando/sdk/errors";
import {
  type ConfigTranslateLayerFragment,
  type ConfigTranslateOutput,
  LandofileAuthoringFragment,
  LandofileAuthoringShape,
} from "@lando/sdk/schema";
import type { ConfigTranslatorShape } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { layerOrder } from "./app-config-translate-document-set.ts";

export const encodeTranslateOutputs = (
  location: { readonly appRoot: string; readonly inputPath: string },
  fragments: {
    readonly outputs: readonly ConfigTranslateOutput[];
    readonly currentLowerV4Fragments: readonly ConfigTranslateLayerFragment[];
  },
  encode: NonNullable<ConfigTranslatorShape["encode"]>,
) =>
  Effect.gen(function* () {
    const outputs = fragments.outputs.toSorted(
      (a, b) => layerOrder(a.targetLayer) - layerOrder(b.targetLayer),
    );
    const ordered = [
      ...fragments.currentLowerV4Fragments.map((f) => ({ layer: f.layerId, fragment: f.fragment })),
      ...outputs.map((o) => ({ layer: o.targetLayer, fragment: o.fragment })),
    ].sort((a, b) => layerOrder(a.layer) - layerOrder(b.layer));
    let merged: Record<string, unknown> = {};
    for (const entry of ordered) {
      const invalidPrefix = (cause: unknown) =>
        new ConfigTranslateError({ message: `Invalid merge prefix at layer ${entry.layer}.`, cause });
      const mapping = yield* Schema.decodeUnknown(
        Schema.Record({ key: Schema.String, value: Schema.Unknown }),
      )(entry.fragment).pipe(Effect.mapError(invalidPrefix));
      merged = mergeLandofiles([merged, mapping]);
      yield* Schema.decodeUnknown(LandofileAuthoringFragment)(merged, { onExcessProperty: "error" }).pipe(
        Effect.mapError(invalidPrefix),
      );
    }
    yield* Schema.decodeUnknown(LandofileAuthoringShape)(merged, { onExcessProperty: "error" }).pipe(
      Effect.mapError(
        (cause) => new ConfigTranslateError({ message: "Translation is not a complete Landofile.", cause }),
      ),
    );
    yield* rejectUnsupportedToolingFeatures(location.inputPath, merged);
    const layers = landofileLayerPaths(location.appRoot);
    return yield* Effect.forEach(outputs, (output) =>
      Effect.gen(function* () {
        const path = layers.find((layer) => layer.layer === output.targetLayer)?.yamlPath;
        if (path === undefined)
          return yield* Effect.fail(
            new ConfigTranslateError({ message: `No declared target for ${output.targetLayer}.` }),
          );
        const result = yield* encode({ context: merged, fragment: output.fragment });
        return {
          target: { layer: output.targetLayer, path, content: result.text },
          diagnostics: result.diagnostics,
        };
      }),
    );
  });
