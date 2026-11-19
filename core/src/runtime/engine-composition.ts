import { resolveContainerHelper } from "@lando/container-runtime/container-helper/assets";
import { resolveUserCacheRoot, resolveUserIncludesDir } from "@lando/engine/cache/paths";
import { type EngineCompositionInputs, installEngineCompositionIfAbsent } from "@lando/engine/composition";
import { BuildSourceStore } from "@lando/engine/services/build-source-store";
import { httpJsonFetch } from "@lando/engine/services/json-fetch";
import { service as processRunner } from "@lando/engine/services/process-runner";
import { defaultSystemCaPems } from "@lando/http-client/network-trust";
import { StateStore } from "@lando/sdk/services";
import { makeSourceStore } from "@lando/source-acquisition";
import { makeGitTransport } from "@lando/source-acquisition/git";
import { Context, Effect, Layer } from "effect";
import { BUILT_IN_COMMAND_IDS } from "../cli/generated/command-ids";
import { makeArchiveTransport } from "../recipes/archive-transport";
import { defaultNpmRegistryClient } from "../recipes/npm-registry-client";
import { npmRegistryConfigSnapshot } from "../recipes/npm-registry-config";
import { retainedSourceTransports } from "../recipes/runtime-sources";

export const buildSourceStoreLayer = Layer.effect(
  BuildSourceStore,
  Effect.gen(function* () {
    const stateStore = yield* StateStore;
    const session = Effect.gen(function* () {
      const { transports } = yield* retainedSourceTransports();
      return yield* makeSourceStore({ stateStore, transports }).session;
    });
    const retained = yield* Effect.context<never>();
    return BuildSourceStore.of({
      session: session.pipe(Effect.updateContext((invocation) => Context.merge(retained, invocation))),
    });
  }),
);

export const baseEngineCompositionInputs: EngineCompositionInputs = {
  bundledPluginModules: [],
  builtInCommandIds: BUILT_IN_COMMAND_IDS,
  landofileSourcePorts: (client, downloader, runtime) => {
    const archive = makeArchiveTransport(downloader, runtime?.requestContext);
    const npmClient = defaultNpmRegistryClient({
      fetchJson: (url, options) => httpJsonFetch(url, options, client),
      snapshot: npmRegistryConfigSnapshot(runtime?.registerSecrets, runtime?.readPolicy),
      archive,
    });
    const gitOptions = {
      systemCaPems: defaultSystemCaPems,
      ...(runtime?.resolveNetworkTrust === undefined ? {} : { trust: runtime.resolveNetworkTrust }),
    };
    return {
      sources: {
        git: makeGitTransport(runtime?.processRunner ?? processRunner, gitOptions),
        npmRegistry: npmClient,
        archive,
      },
    };
  },
  landofileRuntimeInputs: {
    ports: {
      resolveUserCacheRoot,
      resolveUserIncludesDir,
      sources: {
        git: makeGitTransport(processRunner),
        npmRegistry: defaultNpmRegistryClient(),
        archive: makeArchiveTransport(),
      },
    },
    templates: { modules: [] },
  },
  hostProxyWorkerEntry: () => ({
    execPath: process.execPath,
    entryPath: process.argv[1],
    bunSourceEntryPath: new URL("../../bin/lando.ts", import.meta.url).pathname,
  }),
  resolveContainerHelper,
};

installEngineCompositionIfAbsent(baseEngineCompositionInputs);
