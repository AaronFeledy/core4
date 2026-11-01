import {
  Downloader,
  type LandofileService,
  type ManagedFileTransactionGuard,
  PathsService,
  StateStore,
} from "@lando/sdk/services";
import { Context, Effect, Layer, Option } from "effect";

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
  type LandofileFinalizeOverrides,
  acquireLandofileReplacement as acquireLandofileReplacementPackage,
  findDiscoveredLandofilePath,
  loadLandofileFile as loadLandofileFilePackage,
  loadLandofileLayers as loadLandofileLayersPackage,
  prepareLandofileReplacement as prepareLandofileReplacementPackage,
  validateLandofileReplacement as validateLandofileReplacementPackage,
} from "@lando/landofile/service";
import * as LandofileServiceLayer from "@lando/landofile/service";
import {
  type RenderLandofileTemplateOptions,
  buildTemplateEngineRegistry,
  renderLandofileTemplate as renderLandofileTemplatePackage,
} from "@lando/landofile/template-render";
import * as HttpClient from "effect/http/HttpClient";
import { landofileRuntimeInputs, landofileSourcePorts } from "../composition.ts";

const ReadOnlyLandofile = Context.Reference<boolean>("@lando/engine/ReadOnlyLandofile", {
  defaultValue: () => false,
});

export const withReadOnlyLandofile = <A, E, R>(body: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  body.pipe(Effect.provideService(ReadOnlyLandofile, true));

export const scopedLandofileRuntimeInputs: Effect.Effect<LandofileRuntimeInputs> = Effect.gen(function* () {
  const inputs = landofileRuntimeInputs();
  const paths = yield* Effect.serviceOption(PathsService);
  const stateStore = yield* Effect.serviceOption(StateStore);
  const client = yield* Effect.serviceOption(HttpClient.HttpClient);
  const downloader = yield* Effect.serviceOption(Downloader);
  return {
    ...inputs,
    readOnly: yield* ReadOnlyLandofile,
    ...(Option.isNone(stateStore) ? {} : { stateStore: stateStore.value }),
    ports: {
      ...inputs.ports,
      ...(Option.isSome(client) && Option.isSome(downloader)
        ? landofileSourcePorts(client.value, downloader.value)
        : {}),
      ...(Option.isNone(paths)
        ? {}
        : {
            resolveUserIncludesDir: () => paths.value.userIncludesDir,
            resolveUserCacheRoot: () => paths.value.roots.userCacheRoot,
          }),
    },
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
  overrides?: LandofileFinalizeOverrides,
) =>
  Effect.flatMap(scopedLandofileRuntimeInputs, (inputs) =>
    validateLandofileReplacementPackage(replacement, { ...inputs, overrides }),
  );

export const acquireLandofileReplacement = (
  replacement: Parameters<typeof acquireLandofileReplacementPackage>[0],
  overrides?: LandofileFinalizeOverrides,
) =>
  Effect.flatMap(scopedLandofileRuntimeInputs, (inputs) =>
    inputs.readOnly
      ? prepareLandofileReplacementPackage(replacement, { ...inputs, overrides })
      : acquireLandofileReplacementPackage(replacement, { ...inputs, overrides }),
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

export const loadLandofileLayers = (
  appRoot: string,
  canonicalPath: string,
  overrides?: LandofileFinalizeOverrides,
) =>
  Effect.flatMap(StateStore, (stateStore) =>
    Effect.flatMap(scopedLandofileRuntimeInputs, (inputs) =>
      loadLandofileLayersPackage(appRoot, canonicalPath, {
        ...inputs,
        stateStore,
        overrides,
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
