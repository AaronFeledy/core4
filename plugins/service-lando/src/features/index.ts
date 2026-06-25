import type { ServiceFeatureDefinition } from "@lando/sdk/services";

import { landoAppMountFeature } from "./app-mount.ts";
import { landoEnvFeature } from "./env.ts";
import { landoHealthcheckFeature } from "./healthcheck.ts";
import { landoStorageFeature } from "./storage.ts";
import { landoUserIdFeature } from "./user-id.ts";
import { landoUserFeature } from "./user.ts";

export { landoAppMountFeature } from "./app-mount.ts";
export { landoEnvFeature } from "./env.ts";
export { landoHealthcheckFeature } from "./healthcheck.ts";
export { landoStorageFeature } from "./storage.ts";
export { landoUserFeature } from "./user.ts";
export { landoUserIdFeature } from "./user-id.ts";

const definitions: ReadonlyArray<ServiceFeatureDefinition> = [
  landoUserIdFeature,
  landoStorageFeature,
  landoEnvFeature,
  landoAppMountFeature,
  landoHealthcheckFeature,
  landoUserFeature,
];

export const serviceFeatures: ReadonlyMap<string, ServiceFeatureDefinition> = new Map(
  definitions.map((definition) => [definition.id, definition]),
);

export const SERVICE_FEATURE_IDS: ReadonlyArray<string> = definitions.map((definition) => definition.id);
