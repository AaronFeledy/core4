/**
 * Retained composition for recipe source acquisition.
 *
 * Keep one scoped SourceSession alive through acquisition, preparation, and
 * publication so acquired trees remain leased while recipes use them.
 */
import { hostConfigReadPolicy } from "@lando/engine/services/config";
import { httpJsonFetch } from "@lando/engine/services/json-fetch";
import { service as processRunnerService } from "@lando/engine/services/process-runner";
import { NetworkTrust, defaultSystemCaPems, resolveTrust } from "@lando/http-client/network-trust";
import { RedactionService } from "@lando/redaction/service";
import { Downloader, ProcessRunner, StateStore } from "@lando/sdk/services";
import { type SourceStore, type SourceTransports, makeSourceStore } from "@lando/source-acquisition";
import { makeGitTransport } from "@lando/source-acquisition/git";
import { Context, Effect, Option } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import { makeArchiveTransport } from "./archive-transport";
import { defaultNpmRegistryClient } from "./npm-registry-client";
import { npmRegistryConfigSnapshot } from "./npm-registry-config";
import { DEFAULT_RECIPE_REGISTRY_URL, defaultRecipeRegistryClient } from "./registry-source";

export interface RetainedRecipeSourceBundle {
  readonly store: SourceStore;
  readonly registryClient: ReturnType<typeof defaultRecipeRegistryClient>;
  readonly npmRegistryClient: ReturnType<typeof defaultNpmRegistryClient>;
  readonly transports: SourceTransports;
}

export const retainedSourceTransports = Effect.fnUntraced(function* (registryUrl?: string) {
  const client = yield* Effect.serviceOption(HttpClient.HttpClient);
  const downloader = yield* Effect.serviceOption(Downloader);
  const processRunner = yield* Effect.serviceOption(ProcessRunner);
  const redaction = yield* Effect.serviceOption(RedactionService);
  const readPolicy = yield* hostConfigReadPolicy;
  const requestContext = yield* Effect.context<never>();
  const injectedTrust = Context.get(requestContext, NetworkTrust);
  const trustEnv = readPolicy?.env ?? { ...process.env };
  const npmConfig = npmRegistryConfigSnapshot(
    Option.isSome(redaction)
      ? (tokens) => Effect.runPromise(redaction.value.registerValues(tokens))
      : undefined,
    readPolicy,
  );
  const fetchJson: typeof httpJsonFetch = (url, options) =>
    httpJsonFetch(url, options, Option.getOrUndefined(client));
  const archive = makeArchiveTransport(Option.getOrUndefined(downloader), requestContext);
  const npmClient = defaultNpmRegistryClient({
    ...(registryUrl === undefined ? {} : { registryUrl }),
    fetchJson,
    snapshot: npmConfig,
    archive,
  });
  const transports: SourceTransports = {
    git: makeGitTransport(
      Option.getOrElse(processRunner, () => processRunnerService),
      {
        trust: () => Effect.runPromise(resolveTrust(requestContext, injectedTrust, trustEnv)),
        systemCaPems: defaultSystemCaPems,
      },
    ),
    archive,
    npmRegistry: npmClient,
  };
  return {
    transports,
    npmRegistryClient: npmClient,
    registryClient: defaultRecipeRegistryClient(registryUrl ?? DEFAULT_RECIPE_REGISTRY_URL, fetchJson),
  };
});

export const retainedRecipeSourceStore = Effect.fnUntraced(function* (registryUrl?: string) {
  const stateStore = yield* StateStore;
  const bundle = yield* retainedSourceTransports(registryUrl);
  return {
    ...bundle,
    store: makeSourceStore({ stateStore, transports: bundle.transports }),
  } satisfies RetainedRecipeSourceBundle;
});
