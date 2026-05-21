# SDK compatibility guard

`@lando/sdk` is the stable plugin-author surface. Compatibility tests freeze the MVP schema names and service tag signatures, then require every Alpha addition to remain additive and listed here.

## Additive Alpha schema exports

- `AbsolutePath`
- `AppMountPlan`
- `ArtifactBuildSpec`
- `ArtifactRef`
- `BuildBlock`
- `BuildPhase`
- `BuildPlan`
- `BuildScript`
- `BuildStep`
- `BunShellScriptFrontMatter`
- `CertificatePlan`
- `CommandSpec`
- `DataStoreMountPlan`
- `defineLandofile`
- `DataStorePlan`
- `DependencyPlan`
- `EndpointInput`
- `EndpointPlan`
- `HealthcheckInput`
- `HealthcheckPlan`
- `HostAliasPlan`
- `HostArchitecture`
- `MountInput`
- `MountPlan`
- `NetworkPlan`
- `PlanMetadata`
- `PluginContribution`
- `PluginName`
- `PortablePath`
- `ProviderExtensionConfig`
- `RecipeFile`
- `RecipeId`
- `RecipeManifest`
- `RecipePostInitAction`
- `RecipePostInitBun`
- `RecipePostInitCommand`
- `RecipePostInitGitInit`
- `RecipePostInitMessage`
- `RecipePrompt`
- `RecipePromptChoice`
- `RecipePromptType`
- `RecipePromptValidate`
- `RecipeRequires`
- `RecipeVersion`
- `RouteInput`
- `RoutePlan`
- `RouteRef`
- `ServiceConfig`
- `StorageInput`
- `StorageScope`
- `TelemetryConfig`
- `TemplateRenderContext`
- `ToolingTaskShape`
- `ToolingVar`
- `ToolingVarDefault`
- `ToolingVarLiteral`
- `ToolingVarPrompt`
- `ToolingVarSh`

## Additive Alpha service tags

- `CertificateAuthority`
- `CommandFramework`
- `CommandRegistry`
- `HealthcheckRunner`
- `PluginSource`
- `PrivilegeService`
- `ProxyService`
- `RecipeManifestService`
- `Renderer`
- `SchemaValidator`
- `SecretStore`
- `Telemetry`
- `ToolingEngine`
- `UpdateService`
- `UrlScanner`
