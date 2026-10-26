import { httpJsonFetch } from "@lando/engine/services/json-fetch";
import { ConfigService, Downloader } from "@lando/sdk/services";
import { Effect, Option } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import { DEFAULT_NPM_REGISTRY_URL, defaultNpmRegistryClient } from "./npm-source";
import { DEFAULT_RECIPE_REGISTRY_URL, defaultRecipeRegistryClient } from "./registry-source";
import { makeTarballRecipeFetcher } from "./tarball-source";

export const retainedRecipeSources = Effect.fnUntraced(function* (registryUrl?: string) {
  const client = yield* Effect.serviceOption(HttpClient.HttpClient);
  const downloader = yield* Effect.serviceOption(Downloader);
  const config = yield* Effect.serviceOption(ConfigService);
  const userDataRoot = Option.isSome(config) ? yield* config.value.get("userDataRoot") : undefined;
  const fetchJson: typeof httpJsonFetch = (url, options) =>
    httpJsonFetch(url, options, Option.getOrUndefined(client));
  return {
    ...(userDataRoot === undefined ? {} : { userDataRoot }),
    npmRegistryClient: defaultNpmRegistryClient(registryUrl ?? DEFAULT_NPM_REGISTRY_URL, fetchJson),
    registryClient: defaultRecipeRegistryClient(registryUrl ?? DEFAULT_RECIPE_REGISTRY_URL, fetchJson),
    tarballRecipeFetcher: makeTarballRecipeFetcher(Option.getOrUndefined(downloader)),
  };
});
