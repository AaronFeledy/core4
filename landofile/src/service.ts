import { dirname, join } from "node:path";
import { LandofileNotFoundError, LandofileParseError } from "@lando/sdk/errors";
import { LandofileService, ManagedFileTransactionGuard, StateStore } from "@lando/sdk/services";
import { Cause, Effect, Layer } from "effect";
import { LANDOFILE_NAME } from "./discovery.ts";
import { compileLandofileFile } from "./file-compile.ts";
import { landofileLayerPaths, presentLandofileLayers, representativeLandofileLayer } from "./layers.ts";
import { type LandofileLoadContext, ensureConsistentRoot } from "./load-context.ts";
import { mergeLandofileRootLayers } from "./merge-validate.ts";
import type { LandofileLoadScope } from "./pipeline/materialize.ts";
import type { LandofileRuntimeInputs } from "./ports.ts";

export { LandofileService } from "@lando/sdk/services";
export { validateLandofileReplacement } from "./replacement.ts";
export {
  acquireLandofileRootLayers,
  composeLandofileRootLayers,
  prepareLandofileRootLayers,
} from "./root-compile.ts";
export { prepareLandofileSource, resolveLandofileSourceExpressions } from "./source.ts";

export const findDiscoveredLandofilePath = Effect.fn("Landofile.findDiscoveredPath")(function* (cwd: string) {
  const searched: string[] = [];
  let current = cwd;
  for (;;) {
    const candidates = landofileLayerPaths(current);
    searched.push(...candidates.flatMap(({ yamlPath, typescriptPath }) => [yamlPath, typescriptPath]));
    const layer = representativeLandofileLayer(yield* presentLandofileLayers(current));
    if (layer !== undefined) return { filePath: layer.filePath, appRoot: dirname(layer.filePath) };
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return yield* Effect.fail(
    new LandofileNotFoundError({
      message: `No .lando.yml or .lando.ts found. Searched: ${searched.join(", ")}`,
      cwd,
    }),
  );
});

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
      const layer = representativeLandofileLayer(yield* presentLandofileLayers(current));
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
        remediation: `Correct the Landofile under ${process.cwd()} or run the command from a Lando app root.`,
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
