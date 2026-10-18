import { dirname, join } from "node:path";
import { LandofileFormConflictError, LandofileNotFoundError, LandofileParseError } from "@lando/sdk/errors";
import { LandofileService, ManagedFileTransactionGuard, StateStore } from "@lando/sdk/services";
import { Cause, Effect, Layer } from "effect";
import type { LandofileLoadScope } from "./compile.ts";
import { LANDOFILE_NAME } from "./discovery.ts";
import { compileLandofileFile } from "./file-compile.ts";
import { landofileLayerPaths, presentLandofileLayers, representativeLandofileLayer } from "./layers.ts";
import { type LandofileLoadContext, ensureConsistentRoot } from "./load-context.ts";
import { mergeLandofileRootLayers } from "./merge-validate.ts";
import type { LandofileRuntimeInputs } from "./ports.ts";

export { LandofileService } from "@lando/sdk/services";

export const findDiscoveredLandofilePath = async (
  cwd: string,
): Promise<{ readonly filePath: string; readonly appRoot: string }> => {
  const searched: string[] = [];
  let current = cwd;
  for (;;) {
    const candidates = landofileLayerPaths(current);
    searched.push(...candidates.flatMap(({ yamlPath, typescriptPath }) => [yamlPath, typescriptPath]));
    const layer = representativeLandofileLayer(await presentLandofileLayers(current));
    if (layer !== undefined) return { filePath: layer.filePath, appRoot: dirname(layer.filePath) };
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new LandofileNotFoundError({
    message: `No .lando.yml or .lando.ts found. Searched: ${searched.join(", ")}`,
    cwd,
  });
};

export const loadLandofileFile = Effect.fn("Landofile.loadFile")(function* (
  filePath: string,
  context?: LandofileLoadContext,
  inputs?: LandofileRuntimeInputs,
  scope?: LandofileLoadScope,
) {
  const { landofile } = yield* compileLandofileFile(filePath, context, inputs, scope);
  return landofile;
});

export const loadLandofileLayers = Effect.fn("Landofile.loadLayers")(mergeLandofileRootLayers);

const makeDiscoverLandofile = Effect.fn("LandofileService.discover")(
  function* (inputs: LandofileRuntimeInputs) {
    const searched: string[] = [];
    let current = process.cwd();
    for (;;) {
      yield* ensureConsistentRoot(current, inputs);
      const candidates = landofileLayerPaths(current);
      searched.push(...candidates.flatMap(({ yamlPath, typescriptPath }) => [yamlPath, typescriptPath]));
      const layer = yield* Effect.tryPromise({
        try: async () => representativeLandofileLayer(await presentLandofileLayers(current)),
        catch: (cause) => {
          if (
            cause instanceof LandofileNotFoundError ||
            cause instanceof LandofileFormConflictError ||
            cause instanceof LandofileParseError
          )
            return cause;
          return new LandofileParseError({
            message: cause instanceof Error ? cause.message : "Failed to discover Landofile.",
            filePath: join(process.cwd(), LANDOFILE_NAME),
            line: undefined,
            column: undefined,
            cause,
          });
        },
      });
      if (layer !== undefined)
        return yield* loadLandofileLayers(dirname(layer.filePath), layer.filePath, inputs);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return yield* Effect.fail(
      new LandofileNotFoundError({
        message: `No .lando.yml or .lando.ts found. Searched: ${searched.join(", ")}`,
        cwd: process.cwd(),
      }),
    );
  },
  Effect.catchCause((cause) => {
    const failure = Cause.findErrorOption(cause);
    if (failure._tag === "Some") return Effect.fail(failure.value);
    return Effect.fail(
      new LandofileParseError({
        message: "Failed to load Landofile.",
        filePath: join(process.cwd(), LANDOFILE_NAME),
        line: undefined,
        column: undefined,
        cause,
      }),
    );
  }),
);

export const layer = (inputs: LandofileRuntimeInputs) =>
  Layer.effect(
    LandofileService,
    Effect.gen(function* () {
      const transactionGuard = yield* ManagedFileTransactionGuard;
      const stateStore = yield* StateStore;
      return LandofileService.of({
        discover: makeDiscoverLandofile({ ...inputs, transactionGuard, stateStore }),
      });
    }),
  );
