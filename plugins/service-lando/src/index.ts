import { Layer, Schema } from "effect";

import { PluginManifest } from "@lando/sdk/schema";
import type { ServiceTypeShape } from "@lando/sdk/services";

import { nodeLtsServiceType } from "./services/node.ts";
import { php82ServiceType, php83ServiceType } from "./services/php.ts";
import { postgresServiceType } from "./services/postgres.ts";

export const PLUGIN_NAME = "@lando/service-lando" as const;

export { nodeLtsServiceType } from "./services/node.ts";
export { php82ServiceType, php83ServiceType } from "./services/php.ts";
export { postgresServiceType } from "./services/postgres.ts";

export const serviceTypes: ReadonlyMap<string, ServiceTypeShape> = new Map<string, ServiceTypeShape>([
  ["node:lts", nodeLtsServiceType],
  ["postgres", postgresServiceType],
  ["php:8.2", php82ServiceType],
  ["php:8.3", php83ServiceType],
]);

export const services = Layer.empty;

export const manifest = Schema.decodeSync(PluginManifest)({
  name: PLUGIN_NAME,
  version: "0.0.0",
  api: 4,
  description: "The opinionated `lando` service base.",
  enabled: true,
  contributes: { serviceTypes: ["node:lts", "postgres", "php:8.2", "php:8.3"] },
  entry: "./src/index.ts",
});
