import { Layer, Schema } from "effect";

import { PluginManifest } from "@lando/sdk/schema";
import type { ServiceTypeShape } from "@lando/sdk/services";

import { node22ServiceType, nodeLtsServiceType } from "./services/node.ts";
import { php82ServiceType, php83ServiceType } from "./services/php.ts";
import { postgresServiceType } from "./services/postgres.ts";
import { python312ServiceType } from "./services/python.ts";
import { ruby33ServiceType } from "./services/ruby.ts";

export const PLUGIN_NAME = "@lando/service-lando" as const;

export { node22ServiceType, nodeLtsServiceType } from "./services/node.ts";
export { php82ServiceType, php83ServiceType } from "./services/php.ts";
export { postgresServiceType } from "./services/postgres.ts";
export { python312ServiceType } from "./services/python.ts";
export { ruby33ServiceType } from "./services/ruby.ts";

export const serviceTypes: ReadonlyMap<string, ServiceTypeShape> = new Map<string, ServiceTypeShape>([
  ["node:lts", nodeLtsServiceType],
  ["node:22", node22ServiceType],
  ["postgres", postgresServiceType],
  ["php:8.2", php82ServiceType],
  ["php:8.3", php83ServiceType],
  ["python:3.12", python312ServiceType],
  ["ruby:3.3", ruby33ServiceType],
]);

export const services = Layer.empty;

export const manifest = Schema.decodeSync(PluginManifest)({
  name: PLUGIN_NAME,
  version: "0.0.0",
  api: 4,
  description: "The opinionated `lando` service base.",
  enabled: true,
  contributes: {
    serviceTypes: ["node:lts", "node:22", "postgres", "php:8.2", "php:8.3", "python:3.12", "ruby:3.3"],
  },
  entry: "./src/index.ts",
});
