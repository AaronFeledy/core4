import { sha256Hex } from "@lando/sdk/digest";
import { Effect } from "effect";
import { canonicalMissingAppRoot } from "../operations/app-mutation-lock.ts";

export const BUILT_ARTIFACT_STORE_LABEL = "dev.lando.build-store";

export const artifactBuildStoreKey = (userCacheRoot: string) =>
  canonicalMissingAppRoot(userCacheRoot).pipe(Effect.map((root) => sha256Hex(root).slice(0, 8)));
const imageComponent = (value: string, length: number): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, length)
    .replace(/-+$/g, "");
export const artifactBuildName = (
  store: string,
  provider: string,
  service: string,
  buildKey: string,
): string =>
  `lando-build-${store}-${imageComponent(provider, 64)}-${imageComponent(service, 128)}-${buildKey.slice(0, 24)}`;
