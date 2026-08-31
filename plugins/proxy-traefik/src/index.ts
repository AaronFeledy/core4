/**
 * `@lando/proxy-traefik` — Traefik-backed RouterService + bundled global service.
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
import { leftoverProxyPortsCheck } from "./leftover-proxy-ports.ts";
import { preferredHostPortsCheck } from "./preferred-host-ports.ts";
import { proxy } from "./proxy.ts";

export const PLUGIN_NAME = "@lando/proxy-traefik" as const;

export { makeTraefikRouterService, proxy, renderTraefikDynamicConfig } from "./proxy.ts";
export { leftoverProxyPortsCheck } from "./leftover-proxy-ports.ts";
export { preferredHostPortsCheck } from "./preferred-host-ports.ts";
export { proxyTlsDoctorCheck } from "./doctor-tls.ts";
export { TRAEFIK_DYNAMIC_CONFIG_DIR, TRAEFIK_IMAGE } from "./global-services/traefik.ts";
export const routerServices = new Map([["traefik", proxy]]);

export const globalServices: ReadonlyMap<string, Effect.Effect<ServiceConfig>> = new Map([
  ["traefik", traefikGlobalService],
]);

export const manifest = Schema.decodeSync(PluginManifest)({
  name: PLUGIN_NAME,
  version: "0.0.0",
  api: 4,
  requires: { "@lando/core": "^4.0.0" },
  description: "Traefik-backed `RouterService` contributing routerServices: [traefik].",
  enabled: true,
  contributes: {
    routerServices: [
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
        summary: "Global Traefik router",
      },
    ],
  },
  entry: "./src/index.ts",
});

export const plugin = definePlugin({
  name: manifest.name,
  manifest,
  layer: proxy,
  routerServices,
  globalServices,
  doctorChecks: [proxyTlsDoctorCheck, leftoverProxyPortsCheck, preferredHostPortsCheck],
});
