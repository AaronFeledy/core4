/**
 * `@lando/proxy-traefik` — Traefik-backed RouterService + bundled global service.
 *
 * The `globalServices` map is the compiled-binary-safe contribution surface:
 * `meta:global:install`'s bundled-first loader reads it instead of dynamically
 * importing the manifest `module:` path (which cannot resolve in a
 * `bun build --compile` binary).
 */
import { Schema } from "effect";

import { type GlobalServiceContributionEffect, definePlugin } from "@lando/sdk/plugins";
import { PluginManifest } from "@lando/sdk/schema";

import { advertisedProxyPortsCheck } from "./advertised-proxy-ports.ts";
import { proxyTlsDoctorCheck } from "./doctor-tls.ts";
import diagnosticsGlobalService from "./global-services/diagnostics.ts";
import traefikGlobalService from "./global-services/traefik.ts";
import { leftoverProxyPortsCheck } from "./leftover-proxy-ports.ts";
import { preferredHostPortsCheck } from "./preferred-host-ports.ts";
import { proxy } from "./proxy.ts";

export const PLUGIN_NAME = "@lando/proxy-traefik" as const;

export { makeTraefikRouterService, proxy, renderTraefikDynamicConfig } from "./proxy.ts";
export { advertisedProxyPortsCheck } from "./advertised-proxy-ports.ts";
export { leftoverProxyPortsCheck } from "./leftover-proxy-ports.ts";
export { preferredHostPortsCheck } from "./preferred-host-ports.ts";
export { proxyTlsDoctorCheck } from "./doctor-tls.ts";
export { TRAEFIK_DYNAMIC_CONFIG_DIR, TRAEFIK_IMAGE } from "./global-services/traefik.ts";
export {
  TRAEFIK_DIAGNOSTICS_COMMAND,
  TRAEFIK_DIAGNOSTICS_HEALTHCHECK,
  TRAEFIK_DIAGNOSTICS_IMAGE,
} from "./global-services/diagnostics.ts";
export {
  TRAEFIK_DIAGNOSTICS_CONTAINER_DIR,
  TRAEFIK_DIAGNOSTICS_HOSTNAME,
  TRAEFIK_DIAGNOSTICS_ID,
  TRAEFIK_DIAGNOSTICS_PORT,
  renderTraefikDiagnosticHtml,
  renderTraefikDiagnosticNginxConfig,
  renderTraefikFallbackConfig,
} from "./diagnostics.ts";
export const routerServices = new Map([["traefik", proxy]]);

export const globalServices: ReadonlyMap<string, GlobalServiceContributionEffect> = new Map([
  ["traefik", traefikGlobalService],
  ["traefik-diagnostics", diagnosticsGlobalService],
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
      {
        id: "traefik-diagnostics",
        module: "./src/global-services/diagnostics.ts",
        enabledByDefault: true,
        requires: { providerCapabilities: ["sharedCrossAppNetwork"] },
        summary: "Unmatched route diagnostics",
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
  doctorChecks: [
    proxyTlsDoctorCheck,
    leftoverProxyPortsCheck,
    preferredHostPortsCheck,
    advertisedProxyPortsCheck,
  ],
});
