import { basename, relative } from "node:path";
import { LANDOFILE_LAYER_POSITIONS, presentLandofileLayers } from "@lando/landofile/layers";
import { parseLandofile } from "@lando/landofile/parser";
import { ConfigTranslateError, LandofileFormConflictError } from "@lando/sdk/errors";
import type { ConfigTranslateLayerFragment, LandofileLayer, PortablePath } from "@lando/sdk/schema";
import { LandofileAuthoringFragment } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";

const longestBasenamesFirst = LANDOFILE_LAYER_POSITIONS.toSorted(
  (left, right) => right.basename.length - left.basename.length,
);

export const layerForSourcePath = (path: PortablePath | string): LandofileLayer => {
  const filename = basename(path);
  return (
    longestBasenamesFirst.find(
      (position) => filename === `${position.basename}.yml` || filename === `${position.basename}.yaml`,
    )?.layer ?? "canonical"
  );
};

export const LANDOFILE_LAYER_ORDER: ReadonlyArray<LandofileLayer> = LANDOFILE_LAYER_POSITIONS.toSorted(
  (left, right) => left.order - right.order,
).map(({ layer }) => layer);

export const layerOrder = (layer: LandofileLayer): number => LANDOFILE_LAYER_ORDER.indexOf(layer);

export const orderSourcePaths = (paths: ReadonlyArray<PortablePath>): ReadonlyArray<PortablePath> =>
  paths.toSorted(
    (left, right) =>
      layerOrder(layerForSourcePath(left)) - layerOrder(layerForSourcePath(right)) ||
      (left < right ? -1 : left > right ? 1 : 0),
  );

export interface DocumentSetShape {
  readonly mode: "full" | "single-layer";
  readonly selectedSourceIds: ReadonlyArray<string>;
  readonly writableLayerIds: ReadonlyArray<LandofileLayer>;
}

export const buildDocumentSetShape = (args: {
  readonly sourceIds: ReadonlyArray<string>;
  readonly selected: ReadonlyArray<string> | undefined;
}): DocumentSetShape => {
  if (args.selected === undefined || args.selected.length === 0) {
    return {
      mode: "full",
      selectedSourceIds: [...args.sourceIds],
      writableLayerIds: LANDOFILE_LAYER_ORDER,
    };
  }
  const selectedLayers = new Set(args.selected.map(layerForSourcePath));
  return {
    mode: "single-layer",
    selectedSourceIds: [...args.selected],
    writableLayerIds: LANDOFILE_LAYER_ORDER.filter((layer) => selectedLayers.has(layer)),
  };
};

export const lowerV4LayerFragments = (args: {
  readonly appRoot: string;
  readonly selectedSourceIds: ReadonlyArray<string>;
}): Effect.Effect<
  ReadonlyArray<ConfigTranslateLayerFragment>,
  ConfigTranslateError | LandofileFormConflictError
> =>
  Effect.gen(function* () {
    if (args.selectedSourceIds.length === 0) return [];
    const highest = Math.max(...args.selectedSourceIds.map((id) => layerOrder(layerForSourcePath(id))));
    const present = yield* Effect.tryPromise({
      try: () => presentLandofileLayers(args.appRoot),
      catch: (cause) =>
        cause instanceof LandofileFormConflictError
          ? cause
          : new ConfigTranslateError({
              message: "Could not discover lower Landofile layers.",
              remediation: "Check that the app root and its Landofiles are readable.",
              cause,
            }),
    });
    const lower = present
      .filter(
        ({ order, filePath }) =>
          order < highest &&
          !args.selectedSourceIds.includes(relative(args.appRoot, filePath).replaceAll("\\", "/")),
      )
      .toSorted((left, right) => left.order - right.order);
    return yield* Effect.forEach(lower, ({ layer, filePath }) => {
      const relativePath = relative(args.appRoot, filePath).replaceAll("\\", "/");
      const invalidFragment = (cause: unknown) =>
        new ConfigTranslateError({
          message: `${relativePath} is not a v4 Landofile fragment, so it cannot supply single-layer validation context.`,
          remediation: `Convert ${relativePath} first with --file ${relativePath}, or run a full conversion without --file.`,
          cause,
        });
      if (filePath.endsWith(".ts")) return Effect.fail(invalidFragment("TypeScript Landofiles are opaque."));
      return Effect.tryPromise({ try: () => Bun.file(filePath).text(), catch: invalidFragment }).pipe(
        Effect.flatMap((content) =>
          parseLandofile({ file: filePath, content, cwd: args.appRoot }).pipe(
            Effect.flatMap((value) =>
              Schema.decodeUnknown(LandofileAuthoringFragment)(value, { onExcessProperty: "error" }),
            ),
            Effect.flatMap(Schema.encode(LandofileAuthoringFragment)),
            Effect.mapError(invalidFragment),
          ),
        ),
        Effect.map((fragment): ConfigTranslateLayerFragment => ({ layerId: layer, fragment })),
      );
    });
  });
