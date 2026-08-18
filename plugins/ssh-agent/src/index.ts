/**
 * `@lando/ssh-agent` — SSH agent sidecar for forwarding SSH keys.
 *
 * Contributes:
 *   - `sshServices: ["sidecar"]` — the sidecar-backed `SshService` id.
 *   - `globalServices: ["ssh-agent"]` — the bundled global SSH agent sidecar service.
 */
import { type Effect, Schema } from "effect";

import { definePlugin } from "@lando/sdk/plugins";
import { PluginManifest, type ServiceConfig } from "@lando/sdk/schema";

import sshAgentGlobalService from "./global-service.ts";
import { sshService } from "./ssh-service.ts";

export const PLUGIN_NAME = "@lando/ssh-agent" as const;

export const sshServices = new Map([["sidecar", sshService]]);

export const globalServices: ReadonlyMap<string, Effect.Effect<ServiceConfig>> = new Map([
  ["ssh-agent", sshAgentGlobalService],
]);

export const manifest = Schema.decodeSync(PluginManifest)({
  name: PLUGIN_NAME,
  version: "0.0.0",
  api: 4,
  requires: { "@lando/core": "^4.0.0" },
  description: "SSH agent sidecar for forwarding SSH keys into app networks.",
  enabled: true,
  contributes: {
    sshServices: [
      {
        id: "sidecar",
        module: "./src/ssh-service.ts",
        defaultFor: { platform: ["darwin", "linux", "win32"] },
      },
    ],
    globalServices: [
      {
        id: "ssh-agent",
        module: "./src/global-service.ts",
        enabledByDefault: true,
        requires: { providerCapabilities: [] },
        summary: "Global SSH agent sidecar",
      },
    ],
  },
  entry: "./src/index.ts",
});

export const plugin = definePlugin({
  name: manifest.name,
  manifest,
  layer: sshService,
  sshServices,
  globalServices,
});
