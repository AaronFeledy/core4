import { Schema } from "effect";
import { GlobalConfig } from "./config.ts";

// Effective public config, explicitly selected so new loader state stays private.
export const GlobalConfigView = Schema.typeSchema(
  GlobalConfig.pick(
    "userDataRoot",
    "userConfRoot",
    "userCacheRoot",
    "systemPluginRoot",
    "defaultProviderId",
    "defaultRouterService",
    "sshAgent",
    "gpgAgent",
    "defaultSecretStore",
    "appEnv",
    "appLabels",
    "telemetry",
    "renderer",
    "logLevel",
    "allowLoadOutsideRoot",
    "loadMaxFileBytes",
    "loadMaxFilesPerExpression",
    "loadMaxRecursionDepth",
    "network",
    "proxy",
    "router",
    "scanner",
    "mcp",
    "agentEnv",
    "notify",
    "events",
    "sshAgent",
  ),
).annotations({
  identifier: "GlobalConfigView",
  title: "Effective Public Global Config",
  description:
    "Curated effective global settings returned by ConfigService for config view and get; output boundaries redact secrets.",
});
export type GlobalConfigView = typeof GlobalConfigView.Type;
