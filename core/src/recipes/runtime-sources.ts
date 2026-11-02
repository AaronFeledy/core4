import { hostConfigReadPolicy } from "@lando/engine/services/config";
import { httpJsonFetch } from "@lando/engine/services/json-fetch";
import { RedactionService } from "@lando/redaction/service";
import { ConfigService, Downloader } from "@lando/sdk/services";
import { Effect, Option } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import { npmRegistryConfigSnapshot } from "./npm-registry-config";
import { defaultNpmRegistryClient } from "./npm-source";
import { DEFAULT_RECIPE_REGISTRY_URL, defaultRecipeRegistryClient } from "./registry-source";
import { makeTarballRecipeFetcher } from "./tarball-source";

export const retainedRecipeSources = Effect.fnUntraced(function* (registryUrl?: string) {
  const client = yield* Effect.serviceOption(HttpClient.HttpClient);
  const downloader = yield* Effect.serviceOption(Downloader);
  const config = yield* Effect.serviceOption(ConfigService);
  const redaction = yield* Effect.serviceOption(RedactionService);
  const readPolicy = yield* hostConfigReadPolicy;
  const npmConfig = npmRegistryConfigSnapshot(
    Option.isSome(redaction)
      ? (tokens) => Effect.runPromise(redaction.value.registerValues(tokens))
      : undefined,
    readPolicy,
  );
  const userDataRoot = Option.isSome(config) ? yield* config.value.get("userDataRoot") : undefined;
  const fetchJson: typeof httpJsonFetch = (url, options) =>
    httpJsonFetch(url, options, Option.getOrUndefined(client));
  return {
    ...(userDataRoot === undefined ? {} : { userDataRoot }),
    npmRegistryClient: defaultNpmRegistryClient(registryUrl, fetchJson, npmConfig),
    registryClient: defaultRecipeRegistryClient(registryUrl ?? DEFAULT_RECIPE_REGISTRY_URL, fetchJson),
    tarballRecipeFetcher: makeTarballRecipeFetcher(Option.getOrUndefined(downloader)),
  };
});
