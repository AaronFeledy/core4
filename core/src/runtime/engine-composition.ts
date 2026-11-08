import { resolveUserCacheRoot, resolveUserIncludesDir } from "@lando/engine/cache/paths";
import { type EngineCompositionInputs, installEngineCompositionIfAbsent } from "@lando/engine/composition";
import { httpJsonFetch } from "@lando/engine/services/json-fetch";
import { service as processRunner } from "@lando/engine/services/process-runner";
import { defaultSystemCaPems } from "@lando/http-client/network-trust";
import { makeGitTransport } from "@lando/source-acquisition/git";
import { BUILT_IN_COMMAND_IDS } from "../cli/generated/command-ids";
import { resolveContainerHelper } from "../container-helper/assets";
import { makeArchiveTransport } from "../recipes/archive-transport";
import { defaultNpmRegistryClient } from "../recipes/npm-registry-client";
import { npmRegistryConfigSnapshot } from "../recipes/npm-registry-config";

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
