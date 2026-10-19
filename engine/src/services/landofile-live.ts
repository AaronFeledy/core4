import {
  type LandofileService,
  type ManagedFileTransactionGuard,
  PathsService,
  StateStore,
} from "@lando/sdk/services";
import { Effect, Layer, Option } from "effect";

import {
  type ResolveLandofileIncludesOptions,
  type UpdateLandofileIncludesOptions,
  type VerifyLandofileIncludesOptions,
  resolveLandofileIncludes as resolveLandofileIncludesPackage,
  updateLandofileIncludes as updateLandofileIncludesPackage,
  verifyLandofileIncludes as verifyLandofileIncludesPackage,
} from "@lando/landofile/includes";
import type { LintLandofileOptions } from "@lando/landofile/lint";
import { lintLandofileSnapshot as lintLandofileSnapshotPackage } from "@lando/landofile/lint";
import type { LandofileRuntimeInputs } from "@lando/landofile/ports";
import {
  findDiscoveredLandofilePath,
  loadLandofileFile as loadLandofileFilePackage,
  loadLandofileLayers as loadLandofileLayersPackage,
  validateLandofileReplacement as validateLandofileReplacementPackage,
} from "@lando/landofile/service";
import * as LandofileServiceLayer from "@lando/landofile/service";
import {
  type RenderLandofileTemplateOptions,
  buildTemplateEngineRegistry,
  renderLandofileTemplate as renderLandofileTemplatePackage,
} from "@lando/landofile/template-render";
import { landofileRuntimeInputs } from "../composition.ts";

export const scopedLandofileRuntimeInputs: Effect.Effect<LandofileRuntimeInputs> = Effect.gen(function* () {
  const inputs = landofileRuntimeInputs();
  const paths = yield* Effect.serviceOption(PathsService);
  const stateStore = yield* Effect.serviceOption(StateStore);
  return {
    ...inputs,
    ...(Option.isNone(stateStore) ? {} : { stateStore: stateStore.value }),
    ...(Option.isNone(paths)
      ? {}
      : {
          ports: {
            ...inputs.ports,
            resolveUserIncludesDir: () => paths.value.userIncludesDir,
            resolveUserCacheRoot: () => paths.value.roots.userCacheRoot,
          },
        }),
  };
});

export const makeBundledTemplateEngineRegistry = (inputs: LandofileRuntimeInputs) =>
  buildTemplateEngineRegistry(inputs.templates.modules);

export const renderLandofileTemplate = (options: RenderLandofileTemplateOptions) =>
  renderLandofileTemplatePackage({
    ...options,
    registry: options.registry ?? makeBundledTemplateEngineRegistry(landofileRuntimeInputs()),
  });

export const lintLandofile = (options: LintLandofileOptions = {}) =>
  lintLandofileSnapshot(options).pipe(Effect.map(({ result }) => result));

export const lintLandofileSnapshot = (options: LintLandofileOptions = {}) =>
  Effect.flatMap(scopedLandofileRuntimeInputs, (inputs) =>
    lintLandofileSnapshotPackage({ ...options, templates: options.templates ?? inputs.templates }, inputs),
  );

export const resolveLandofileIncludes = (options: ResolveLandofileIncludesOptions) =>
  Effect.flatMap(
    options.stateStore === undefined ? StateStore : Effect.succeed(options.stateStore),
    (stateStore) =>
      Effect.flatMap(scopedLandofileRuntimeInputs, (inputs) =>
        resolveLandofileIncludesPackage({
          ...options,
          ports: options.ports ?? inputs.ports,
          stateStore,
        }),
      ),
  );

export const updateLandofileIncludes = (options: UpdateLandofileIncludesOptions) =>
  Effect.flatMap(
    options.stateStore === undefined ? StateStore : Effect.succeed(options.stateStore),
    (stateStore) =>
      Effect.flatMap(scopedLandofileRuntimeInputs, (inputs) =>
        updateLandofileIncludesPackage({
          ...options,
          ports: options.ports ?? inputs.ports,
          stateStore,
        }),
      ),
  );

export const verifyLandofileIncludes = (options: VerifyLandofileIncludesOptions) =>
  Effect.flatMap(
    options.stateStore === undefined ? StateStore : Effect.succeed(options.stateStore),
    (stateStore) =>
      Effect.flatMap(scopedLandofileRuntimeInputs, (inputs) =>
        verifyLandofileIncludesPackage({
          ...options,
          ports: options.ports ?? inputs.ports,
          stateStore,
        }),
      ),
  );

export { findDiscoveredLandofilePath };

export const validateLandofileReplacement = (
  replacement: Parameters<typeof validateLandofileReplacementPackage>[0],
) =>
  Effect.flatMap(scopedLandofileRuntimeInputs, (inputs) =>
    validateLandofileReplacementPackage(replacement, inputs),
  );

export const loadLandofileFile = (
  filePath: string,
  context?: Parameters<typeof loadLandofileFilePackage>[1],
) =>
  Effect.flatMap(StateStore, (stateStore) =>
    Effect.flatMap(scopedLandofileRuntimeInputs, (inputs) =>
      loadLandofileFilePackage(filePath, context, {
        ...inputs,
        stateStore,
      }),
    ),
  );

export const loadLandofileLayers = (appRoot: string, canonicalPath: string) =>
  Effect.flatMap(StateStore, (stateStore) =>
    Effect.flatMap(scopedLandofileRuntimeInputs, (inputs) =>
      loadLandofileLayersPackage(appRoot, canonicalPath, {
        ...inputs,
        stateStore,
      }),
    ),
  );

export const layer = (
  inputs: LandofileRuntimeInputs,
): Layer.Layer<LandofileService, never, ManagedFileTransactionGuard | StateStore> =>
  LandofileServiceLayer.layer(inputs);

/** Default layer: resolves scoped runtime inputs then builds the Landofile service. */
export const layerDefault = Layer.unwrap(
  Effect.map(scopedLandofileRuntimeInputs, LandofileServiceLayer.layer),
);
