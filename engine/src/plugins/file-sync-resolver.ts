import { importAuthorModule } from "@lando/landofile/author-modules";
import { Context, Effect, Layer, Predicate, Result, Schema, Scope } from "effect";
import * as HttpClient from "effect/http/HttpClient";

import { type FileSyncSelectionError, FileSyncStartError } from "@lando/sdk/errors";
import type { FileSyncEngineContribution, FileSyncEngineContributionLayer } from "@lando/sdk/plugins";
import {
  AbsolutePath,
  type FileSyncEngineCapabilities,
  type FileSyncEngineDescriptor,
} from "@lando/sdk/schema";
import {
  Downloader,
  FileSyncEngine,
  type FileSyncEngineShape,
  ManagedFileService,
  PathsService,
  ProcessRunner,
  StateStore,
} from "@lando/sdk/services";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";

import { makeLandoPluginContext } from "./context.ts";
import { PluginContributionGraph } from "./contribution-graph.ts";
import {
  type GraphFileSyncCandidate,
  collectFileSyncCandidates,
  fileSyncCandidateMetadata,
} from "./file-sync-candidates.ts";
export { collectFileSyncCandidates } from "./file-sync-candidates.ts";

import {
  type FileSyncCandidateDefinition,
  type FileSyncSelectionPolicy,
  selectFileSyncCandidate,
} from "./file-sync-selection.ts";
export {
  type FileSyncBindMountPerformance,
  type FileSyncCandidateDefinition,
  type FileSyncSelectionPolicy,
  selectFileSyncCandidate,
} from "./file-sync-selection.ts";

export interface FileSyncResolverShape {
  readonly candidates: ReadonlyArray<FileSyncCandidateDefinition>;
  readonly select: (
    policy: FileSyncSelectionPolicy,
  ) => Effect.Effect<FileSyncCandidateDefinition | undefined, FileSyncSelectionError>;
  readonly acquire: (id: string) => Effect.Effect<FileSyncEngineShape, FileSyncStartError>;
}

export class FileSyncResolver extends Context.Service<FileSyncResolver, FileSyncResolverShape>()(
  "@lando/engine/FileSyncResolver",
) {
  static readonly layerWithEngine = (
    engine: FileSyncEngineShape,
    supports: FileSyncEngineDescriptor["supports"],
  ) => {
    const candidates: readonly FileSyncCandidateDefinition[] = [
      {
        id: engine.id,
        pluginName: "provided-engine",
        source: "explicit",
        capabilities: engine.capabilities,
        supports,
      },
    ];
    return Layer.succeed(
      this,
      this.of({
        candidates,
        select: (policy) =>
          Result.match(selectFileSyncCandidate(candidates, policy), {
            onFailure: Effect.fail,
            onSuccess: Effect.succeed,
          }),
        acquire: (id) =>
          id === engine.id
            ? Effect.succeed(engine)
            : Effect.fail(
                new FileSyncStartError({
                  engineId: id,
                  message: `Provided engine ${engine.id} cannot acquire recorded engine ${id}.`,
                  remediation: "Provide the recorded file-sync engine at runtime composition.",
                }),
              ),
      }),
    );
  };
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const graph = yield* PluginContributionGraph;
      const paths = yield* PathsService;
      const managedFileService = yield* ManagedFileService;
      const stateStore = yield* StateStore;
      const privateFileAccess = yield* PrivateFileAccessService;
      const httpClient = yield* HttpClient.HttpClient;
      const downloader = yield* Downloader;
      const processRunner = yield* ProcessRunner;
      const scope = yield* Scope.Scope;

      const graphCandidates = collectFileSyncCandidates(graph.plugins);
      const candidates: ReadonlyArray<FileSyncCandidateDefinition> =
        graphCandidates.map(fileSyncCandidateMetadata);

      const engineDeps = Layer.mergeAll(
        Layer.succeed(PathsService, paths),
        Layer.succeed(Downloader, downloader),
        Layer.succeed(ProcessRunner, processRunner),
      );

      const memos = new Map<string, Effect.Effect<FileSyncEngineShape, FileSyncStartError>>();

      const loadEngine = Effect.fnUntraced(function* (id: string) {
        const matching = graphCandidates.filter((entry) => entry.id === id);
        const candidate = matching[0];
        if (candidate === undefined || matching.length !== 1) {
          return yield* Effect.fail(
            new FileSyncStartError({
              engineId: id,
              message: `File-sync engine ${id} must have exactly one enabled contribution for acquisition.`,
              remediation: `Install or enable file-sync engine ${id} and remove duplicate contributions, then retry.`,
            }),
          );
        }
        const layer = yield* loadContributionLayer(candidate, {
          paths,
          managedFileService,
          stateStore,
          privateFileAccess,
          httpClient,
        });
        const provided = layer.pipe(Layer.provide(engineDeps));
        const built = yield* Layer.buildWithScope(provided, scope).pipe(
          Effect.mapError((cause) =>
            cause instanceof FileSyncStartError
              ? cause
              : new FileSyncStartError({
                  engineId: id,
                  message: `Failed to construct file-sync engine ${id}.`,
                  remediation: `Repair plugin ${candidate.pluginName} so file-sync engine ${id} loads.`,
                  cause,
                }),
          ),
        );
        const engine = Context.get(built, FileSyncEngine);
        return yield* validateAcquiredEngine(candidate, engine);
      });

      const acquire = Effect.fn("FileSyncResolver.acquire")(function* (id: string) {
        let memo = memos.get(id);
        if (memo === undefined) {
          memo = yield* Effect.cached(loadEngine(id));
          memos.set(id, memo);
        }
        return yield* memo;
      });

      const select = Effect.fn("FileSyncResolver.select")(function* (policy: FileSyncSelectionPolicy) {
        return yield* Result.match(selectFileSyncCandidate(candidates, policy), {
          onFailure: Effect.fail,
          onSuccess: Effect.succeed,
        });
      });

      return FileSyncResolver.of({ candidates, select, acquire });
    }),
  );
}

// ==== Acquisition helpers.

const planningSensitiveMatch = (
  expected: FileSyncEngineCapabilities,
  actual: FileSyncEngineCapabilities,
): boolean => {
  const modesKey = (modes: ReadonlyArray<string>) => [...modes].sort().join("\0");
  return (
    modesKey(expected.modes) === modesKey(actual.modes) &&
    expected.exclusionPatterns === actual.exclusionPatterns &&
    expected.remoteAgentDeployment === actual.remoteAgentDeployment
  );
};

const validateAcquiredEngine = (
  candidate: GraphFileSyncCandidate,
  engine: FileSyncEngineShape,
): Effect.Effect<FileSyncEngineShape, FileSyncStartError> => {
  if ("boundApp" in engine) {
    return Effect.fail(
      new FileSyncStartError({
        engineId: candidate.id,
        message: `File-sync factory ${candidate.id} returned an app-bound engine.`,
        remediation:
          "Return an unbound engine from make(ctx); bind prepared targets separately for each app.",
      }),
    );
  }
  if (engine.id !== candidate.id) {
    return Effect.fail(
      new FileSyncStartError({
        engineId: candidate.id,
        message: `File-sync contribution ${candidate.id} from ${candidate.pluginName} loaded engine id ${engine.id}.`,
        remediation: `Export a file-sync engine whose id is ${candidate.id} from plugin ${candidate.pluginName}.`,
      }),
    );
  }
  if (!planningSensitiveMatch(candidate.capabilities, engine.capabilities)) {
    return Effect.fail(
      new FileSyncStartError({
        engineId: candidate.id,
        message: `File-sync engine ${candidate.id} capabilities disagree with its contribution metadata.`,
        remediation: `Align modes, exclusionPatterns, and remoteAgentDeployment for ${candidate.id} in plugin ${candidate.pluginName}.`,
      }),
    );
  }
  return Effect.succeed(engine);
};

const isFileSyncContribution = (value: unknown): value is FileSyncEngineContribution =>
  Predicate.isObject(value) && "make" in value && typeof value.make === "function";

const loadContributionLayer = (
  candidate: GraphFileSyncCandidate,
  deps: {
    readonly paths: Context.Service.Shape<typeof PathsService>;
    readonly managedFileService: Context.Service.Shape<typeof ManagedFileService>;
    readonly stateStore: Context.Service.Shape<typeof StateStore>;
    readonly privateFileAccess: Context.Service.Shape<typeof PrivateFileAccessService>;
    readonly httpClient: HttpClient.HttpClient;
  },
): Effect.Effect<FileSyncEngineContributionLayer, FileSyncStartError> => {
  const acquisition = candidate.acquisition;
  if (acquisition.kind === "missing") {
    return Effect.fail(
      new FileSyncStartError({
        engineId: candidate.id,
        message: `File-sync engine ${candidate.id} from ${acquisition.pluginName} has no factory or module path.`,
        remediation: `Declare a make factory or module path for file-sync engine ${candidate.id} in plugin ${acquisition.pluginName}.`,
      }),
    );
  }

  const buildFromContribution = Effect.fnUntraced(function* (
    contribution: FileSyncEngineContribution,
    pluginName: string,
  ) {
    const pluginStateRoot = yield* Schema.decodeUnknownEffect(AbsolutePath)(
      deps.paths.pluginStateDir(pluginName),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new FileSyncStartError({
            engineId: candidate.id,
            message: `Failed to resolve plugin state root for ${pluginName}.`,
            remediation: `Repair paths configuration so plugin ${pluginName} can store durable state.`,
            cause,
          }),
      ),
    );
    return contribution.make(
      makeLandoPluginContext({
        id: pluginName,
        managedFileService: deps.managedFileService,
        stateStore: deps.stateStore,
        pluginStateRoot,
        privateFileAccess: deps.privateFileAccess,
        httpClient: deps.httpClient,
      }),
    );
  });

  if (acquisition.kind === "contribution") {
    return buildFromContribution(acquisition.contribution, acquisition.pluginName);
  }

  return Effect.tryPromise({
    try: () => importAuthorModule(acquisition.module),
    catch: (cause) =>
      new FileSyncStartError({
        engineId: candidate.id,
        message: `Failed to import file-sync engine ${candidate.id} from ${acquisition.module}.`,
        remediation: `Repair plugin ${acquisition.pluginName} so file-sync engine ${candidate.id} loads from ${acquisition.module}.`,
        cause,
      }),
  }).pipe(
    Effect.flatMap((loaded) => {
      if (isFileSyncContribution(loaded)) {
        return buildFromContribution(loaded, acquisition.pluginName);
      }
      if (Predicate.isObject(loaded)) {
        const nested = loaded.fileSyncEngine ?? loaded.default;
        if (isFileSyncContribution(nested)) {
          return buildFromContribution(nested, acquisition.pluginName);
        }
      }
      return Effect.fail(
        new FileSyncStartError({
          engineId: candidate.id,
          message: `File-sync engine module ${acquisition.module} does not export a make factory.`,
          remediation: `Export a { make(ctx) } factory from ${acquisition.module} in plugin ${acquisition.pluginName}.`,
        }),
      );
    }),
  );
};
