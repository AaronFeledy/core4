import { join } from "node:path";
import { LandofileNotFoundError, LandofileParseError } from "@lando/sdk/errors";
import { LandofileService, ManagedFileTransactionGuard, StateStore } from "@lando/sdk/services";
import { Cause, Effect, Layer } from "effect";
import { LANDOFILE_NAME } from "./discovery.ts";
import { compileLandofileFile } from "./file-compile.ts";
import { createIncludeResolutionSession } from "./include-session.ts";
import { presentLandofileLayers, representativeLandofileLayer } from "./layers.ts";
import { type LandofileLoadContext, ensureConsistentRoot } from "./load-context.ts";
import { finalizeLandofileRootLayers, mergeLandofileRootLayers } from "./merge-validate.ts";
import { discoverForOperation, discoveryCwd } from "./operation-discovery.ts";
import type { LandofileLoadScope } from "./pipeline/materialize.ts";
import type { LandofileRuntimeInputs } from "./ports.ts";
import { evaluateLandofileRootLayers } from "./root-compile.ts";

export { LandofileService } from "@lando/sdk/services";
export { validateLandofileReplacement } from "./replacement.ts";
export { prepareLandofileReplacement } from "./prepared-replacement.ts";
export type { LandofileFinalizeOverrides } from "./pipeline/finalize-overrides.ts";
export {
  acquireLandofileRootLayers,
  composeLandofileRootLayers,
  prepareLandofileRootLayers,
} from "./root-compile.ts";
export { prepareLandofileSource, resolveLandofileSourceExpressions } from "./source.ts";

export const findDiscoveredLandofilePath = Effect.fn("Landofile.findDiscoveredPath")(function* (
  cwd?: string,
) {
  const result = yield* discoverForOperation(cwd);
  if (result.kind === "found") {
    const layer = representativeLandofileLayer(yield* presentLandofileLayers(result.directory));
    if (layer !== undefined) return { filePath: layer.filePath, appRoot: result.directory };
  }
  let reason: string;
  let remediation = `Run \`lando init\` in ${result.cwd} to create an app.`;
  switch (result.kind === "stopped" ? result.reason : "missing") {
    case "marker":
      reason = `.lando.stop at ${result.directory}`;
      remediation = `Run \`lando init\` in ${result.cwd}, or move/remove the .lando.stop at ${result.directory} to search above it.`;
      break;
    case "bound":
      reason = "the fixed bound of 64 parent levels";
      break;
    case "root":
      reason = "the filesystem root";
      break;
    case "excluded":
      reason = `the excluded Lando global app or scratch tree at ${result.directory}`;
      break;
    case "missing":
      reason = "the discovered Landofile being removed";
      break;
  }
  return yield* Effect.fail(
    new LandofileNotFoundError({
      message: `No .lando.yml or .lando.ts found. Searched from ${result.cwd} through ${result.directory}; stopped at ${reason}.`,
      cwd: result.cwd,
      remediation,
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
    const cwd = yield* discoveryCwd();
    yield* ensureConsistentRoot(cwd, inputs);
    const discovered = yield* findDiscoveredLandofilePath();
    if (discovered.appRoot !== cwd) yield* ensureConsistentRoot(discovered.appRoot, inputs);
    const session = yield* createIncludeResolutionSession({ appRoot: discovered.appRoot, ...inputs });
    const evaluated = yield* evaluateLandofileRootLayers(discovered.appRoot, { session, inputs });
    return yield* finalizeLandofileRootLayers(evaluated, discovered.filePath, inputs);
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
