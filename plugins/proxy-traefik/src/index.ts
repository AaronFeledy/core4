/**
 * `@lando/proxy-traefik` — Traefik-backed ProxyService + bundled global service.
 *
 * Contributes:
 *   - `proxies: ["traefik"]` — the Traefik-backed `ProxyService` id.
 *   - `globalServices: ["traefik"]` — the bundled global reverse-proxy service
 *     materialized into the global app's `.lando.dist.yml`.
 *   - `doctorChecks: ["proxy-tls"]` — readiness of persisted HTTPS TLS material.
 *
 * The `globalServices` map is the compiled-binary-safe contribution surface:
 * `meta:global:install`'s bundled-first loader reads it instead of dynamically
 * importing the manifest `module:` path (which cannot resolve in a
 * `bun build --compile` binary).
 */
import { type Effect, Schema } from "effect";

import { definePlugin } from "@lando/sdk/plugins";
import { PluginManifest, type ServiceConfig } from "@lando/sdk/schema";

import { proxyTlsDoctorCheck } from "./doctor-tls.ts";
import traefikGlobalService from "./global-services/traefik.ts";
import { proxy } from "./proxy.ts";

export const PLUGIN_NAME = "@lando/proxy-traefik" as const;

export { makeTraefikProxyService, proxy, renderTraefikDynamicConfig } from "./proxy.ts";
export { proxyTlsDoctorCheck } from "./doctor-tls.ts";
export { TRAEFIK_DYNAMIC_CONFIG_DIR, TRAEFIK_IMAGE } from "./global-services/traefik.ts";
export const proxyServices = new Map([["traefik", proxy]]);

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
    proxyServices: [
      {
        id: "traefik",
        module: "./src/proxy.ts",
        defaultFor: { platform: ["darwin", "linux", "win32"] },
      },
    ],
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

export const plugin = definePlugin({
  name: manifest.name,
  manifest,
  layer: proxy,
  proxyServices,
  globalServices,
  doctorChecks: [proxyTlsDoctorCheck],
});
