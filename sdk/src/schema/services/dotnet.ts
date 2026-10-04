import { Schema } from "effect";

import { catalogServiceConfig, catalogServiceType } from "./_catalog.ts";

// ============================================================================
// .NET catalog service authoring contract
// ============================================================================

export const DotnetServiceConfig = catalogServiceConfig({
  extraKeys: ["certs"],
  type: catalogServiceType(
    Schema.Literals(["dotnet", "dotnet:8.0", "dotnet:9.0"]),
    ".NET catalog service type and supported major-version aliases.",
  ),
  identifier: "DotnetServiceConfig",
  title: "Dotnet Service Config",
  description: "Landofile configuration accepted by the .NET catalog service.",
});
export type DotnetServiceConfig = typeof DotnetServiceConfig.Type;
