import { Struct } from "effect";
import { Schema } from "effect";

import { ServiceConfig } from "../landofile.ts";

// ============================================================================
// .NET catalog service authoring contract
// ============================================================================

export const DotnetServiceConfig = Schema.Struct(Struct.pick(ServiceConfig.fields, ["image", "port", "user", "certs", "environment", "routes", "ports", "command", "entrypoint", "workingDirectory", "appMount", "mounts", "storage", "endpoints", "healthcheck", "dependsOn", "labels", "envFile", "networks", "security", "providers"])).pipe(Schema.fieldsAssign({
    type: Schema.optionalKey(Schema.Literals(["dotnet", "dotnet:8.0", "dotnet:9.0"])).annotate({
      description: ".NET catalog service type and supported major-version aliases.",
    }),
  })).annotate({
  identifier: "DotnetServiceConfig",
  title: "Dotnet Service Config",
  description: "Landofile configuration accepted by the .NET catalog service.",
});
export type DotnetServiceConfig = typeof DotnetServiceConfig.Type;
