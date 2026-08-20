import { Schema } from "effect";

import { ServiceConfig } from "../landofile.ts";

// ============================================================================
// .NET catalog service authoring contract
// ============================================================================

export const DotnetServiceConfig = Schema.extend(
  ServiceConfig.pick(
    "image",
    "port",
    "user",
    "certs",
    "environment",
    "routes",
    "ports",
    "command",
    "entrypoint",
    "workingDirectory",
    "appMount",
    "mounts",
    "storage",
    "endpoints",
    "healthcheck",
    "dependsOn",
    "labels",
    "envFile",
    "networks",
    "security",
    "providers",
  ),
  Schema.Struct({
    type: Schema.optional(Schema.Literal("dotnet", "dotnet:8.0", "dotnet:9.0")).annotations({
      description: ".NET catalog service type and supported major-version aliases.",
    }),
  }),
).annotations({
  identifier: "DotnetServiceConfig",
  title: "Dotnet Service Config",
  description: "Landofile configuration accepted by the .NET catalog service.",
});
export type DotnetServiceConfig = typeof DotnetServiceConfig.Type;
