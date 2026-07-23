/**
 * `@lando/proxy-traefik` — Traefik-backed ProxyService + bundled global service.
 *
 * Contributes:
 *   - `proxies: ["traefik"]` — the Traefik-backed `ProxyService` id.
 *   - `globalServices: ["traefik"]` — the bundled global reverse-proxy service
 *     materialized into the global app's `.lando.dist.yml`.
 *
 * The `globalServices` map is the static, compiled-binary-safe contribution
 * surface: `meta:global:install`'s bundled-first loader reads it instead of
 * dynamically importing the manifest `module:` path (which cannot resolve in a
 * `bun build --compile` binary). The manifest still records `module:` for
 * documentation and the non-bundled (future) dynamic-import fallback.
 */
import { type Effect, Schema } from "effect";

import { PluginManifest, type ServiceConfig } from "@lando/sdk/schema";

import traefikGlobalService from "./global-services/traefik.ts";
import { ProxyServiceTraefikGlobalAppLive } from "./proxy-service.ts";

export const PLUGIN_NAME = "@lando/proxy-traefik" as const;

export { ProxyServiceTraefikGlobalAppLive } from "./proxy-service.ts";

export const proxy = ProxyServiceTraefikGlobalAppLive;

/** Static global-service contributions, keyed by contribution id. */
export const globalServices: ReadonlyMap<string, Effect.Effect<ServiceConfig>> = new Map([
  ["traefik", traefikGlobalService],
]);

export const manifest = Schema.decodeSync(PluginManifest)({
  name: PLUGIN_NAME,
  version: "0.0.0",
  api: 4,
  requires: { "@lando/core": "^4.0.0" },
  description: "Traefik-backed `ProxyService` and bundled global reverse proxy.",
  enabled: true,
  contributes: {
    proxies: ["traefik"],
    globalServices: [
      {
        id: "traefik",
        module: "./src/global-services/traefik.ts",
        enabledByDefault: true,
        requires: { providerCapabilities: ["sharedCrossAppNetwork"] },
        summary: "Global Traefik reverse proxy",
      },
    ],
  },
  entry: "./src/index.ts",
});
