import { NetworkTrust, resolveTrust } from "@lando/http-client/network-trust";
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
import * as LandofileServiceLayer from "@lando/landofile/service";
import {
  type LandofileFinalizeOverrides,
  acquireLandofileReplacement as acquireLandofileReplacementPackage,
  findDiscoveredLandofilePath,
  loadLandofileFile as loadLandofileFilePackage,
  loadLandofileLayers as loadLandofileLayersPackage,
  prepareLandofileReplacement as prepareLandofileReplacementPackage,
  validateLandofileReplacement as validateLandofileReplacementPackage,
} from "@lando/landofile/service";
import {
  type RenderLandofileTemplateOptions,
  buildTemplateEngineRegistry,
  renderLandofileTemplate as renderLandofileTemplatePackage,
} from "@lando/landofile/template-render";
import { RedactionService } from "@lando/redaction/service";
import {
  Downloader,
  LandofileService,
  type ManagedFileTransactionGuard,
  PathsService,
  ProcessRunner,
  StateStore,
} from "@lando/sdk/services";
import { Context, Effect, Layer, Option, type Scope } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import { landofileRuntimeInputs, landofileSourcePorts } from "../composition.ts";
import { hostConfigReadPolicy } from "./config.ts";

const ReadOnlyLandofile = Context.Reference<boolean>("@lando/engine/ReadOnlyLandofile", {
  defaultValue: () => false,
});

export const withReadOnlyLandofile = <A, E, R>(
  body: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, Scope.Scope>> =>
  body.pipe(Effect.provideService(ReadOnlyLandofile, true), Effect.scoped);

export const scopedLandofileRuntimeInputs: Effect.Effect<LandofileRuntimeInputs> = Effect.gen(function* () {
  const inputs = landofileRuntimeInputs();
  const paths = yield* Effect.serviceOption(PathsService);
  const stateStore = yield* Effect.serviceOption(StateStore);
  const client = yield* Effect.serviceOption(HttpClient.HttpClient);
  const downloader = yield* Effect.serviceOption(Downloader);
  const processRunner = yield* Effect.serviceOption(ProcessRunner);
  const redaction = yield* Effect.serviceOption(RedactionService);
  const readPolicy = yield* hostConfigReadPolicy;
  const requestContext = yield* Effect.context<never>();
  const injectedTrust = Context.get(requestContext, NetworkTrust);
  const trustEnv = readPolicy?.env ?? { ...process.env };
  const resolveNetworkTrust = () => Effect.runPromise(resolveTrust(requestContext, injectedTrust, trustEnv));
  const runtime = {
    requestContext,
    ...(Option.isSome(processRunner) ? { processRunner: processRunner.value } : {}),
    ...(Option.isSome(redaction)
      ? {
          registerSecrets: (values: ReadonlyArray<string>) =>
            Effect.runPromise(redaction.value.registerValues(values)),
        }
      : {}),
    ...(readPolicy === undefined ? {} : { readPolicy }),
    resolveNetworkTrust,
  };
  return {
    ...inputs,
    readOnly: yield* ReadOnlyLandofile,
    ...(Option.isNone(stateStore) ? {} : { stateStore: stateStore.value }),
    ports: {
      ...inputs.ports,
      ...landofileSourcePorts(Option.getOrUndefined(client), Option.getOrUndefined(downloader), runtime),
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

/** Retains runtime services while resolving source ports in each discover caller's context. */
export const layerDefault = Layer.effect(
  LandofileService,
  Effect.gen(function* () {
    const runtime = yield* Effect.context<ManagedFileTransactionGuard | StateStore>();
    return LandofileService.of({
      discover: Effect.gen(function* () {
        const caller = yield* Effect.context<never>();
        return yield* Effect.flatMap(scopedLandofileRuntimeInputs, (inputs) =>
          Effect.flatMap(LandofileService, (service) => service.discover).pipe(
            Effect.provide(LandofileServiceLayer.layer(inputs)),
          ),
        ).pipe(Effect.provide(Context.merge(runtime, caller)));
      }),
    });
  }),
);
