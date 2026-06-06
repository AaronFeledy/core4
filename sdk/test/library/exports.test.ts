import { describe, expect, test } from "bun:test";

describe("@lando/sdk package exports", () => {
  test("root entry point resolves the public namespaces", async () => {
    const sdk = await import("@lando/sdk");

    expect(sdk.Schema.BootstrapLevel).toBeDefined();
    expect(sdk.Errors.LandoRuntimeBootstrapError).toBeDefined();
    expect(sdk.Events.LandoEvent).toBeDefined();
    expect(sdk.Services.RuntimeProvider).toBeDefined();
    expect(sdk.Secrets.createSecretRedactor).toBeDefined();
  });

  test("schema entry point exports the canonical contract surface", async () => {
    const schema = await import("@lando/sdk/schema");

    expect(schema.BootstrapLevel).toBeDefined();
    expect(schema.BOOTSTRAP_RANK).toBeDefined();
    expect(schema.AppRef).toBeDefined();
    expect(schema.AppPlan).toBeDefined();
    expect(schema.ServicePlan).toBeDefined();
    expect(schema.ProviderCapabilities).toBeDefined();
    expect(schema.LandofileShape).toBeDefined();
    expect(schema.IncludeEntry).toBeDefined();
    expect(schema.GlobalConfig).toBeDefined();
    expect(schema.ConfigLintViolation).toBeDefined();
    expect(schema.ConfigLintResult).toBeDefined();
    expect(schema.AppId).toBeDefined();
    expect(schema.ServiceName).toBeDefined();
    expect(schema.ProviderId).toBeDefined();
    expect(schema.HostPlatform).toBeDefined();
    expect(schema.ServiceInfo).toBeDefined();
    expect(schema.PluginManifest).toBeDefined();
    expect(schema.EmbeddingPluginPolicy).toBeDefined();
    expect(schema.RecipeRegistryResolution).toBeDefined();
    expect(schema.RecipeRegistryResponse).toBeDefined();
    expect(schema.RecipeChoicesFrom).toBeDefined();
    expect(schema.Transcript).toBeDefined();
    expect(schema.getJsonSchema).toBeDefined();
  });

  test("schema entry point exposes JSON Schema for the canonical contract surface", async () => {
    const schema = await import("@lando/sdk/schema");

    for (const schemaName of [
      "BootstrapLevel",
      "AppRef",
      "AppPlan",
      "ServicePlan",
      "ProviderCapabilities",
      "LandofileShape",
      "GlobalConfig",
      "ConfigLintViolation",
      "ConfigLintResult",
      "AppId",
      "ServiceName",
      "ProviderId",
      "HostPlatform",
      "ServiceInfo",
      "PluginManifest",
      "Transcript",
    ] as const) {
      const jsonSchema = schema.getJsonSchema(schemaName);

      expect(jsonSchema).toBeDefined();
      expect(jsonSchema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    }
  });

  test("errors entry point exports the canonical tagged errors", async () => {
    const errors = await import("@lando/sdk/errors");

    expect(errors.LandoRuntimeBootstrapError).toBeDefined();
    expect(errors.ProviderCapabilityError).toBeDefined();
    expect(errors.LandofileParseError).toBeDefined();
    expect(errors.LandofileExpressionParseError).toBeDefined();
    expect(errors.LandofileExpressionForbiddenError).toBeDefined();
    expect(errors.LandofileExpressionEvalError).toBeDefined();
    expect(errors.LandofileLockMismatchError).toBeDefined();
    expect(errors.LandofileIncludeError).toBeDefined();
    expect(errors.PluginLoadError).toBeDefined();
    expect(errors.NoProviderInstalledError).toBeDefined();
    expect(errors.ConfigError).toBeDefined();
    expect(errors.CacheError).toBeDefined();
    expect(errors.EventError).toBeDefined();
    expect(errors.FileNotFoundError).toBeDefined();
    expect(errors.FilePermissionError).toBeDefined();
    expect(errors.FileIoError).toBeDefined();
    expect(errors.GuideFixtureNotFoundError).toBeDefined();
    expect(errors.GuideFixtureSymlinkError).toBeDefined();
    expect(errors.GuideFrontmatterValidationError).toBeDefined();
    expect(errors.GuideHiddenScenarioReasonError).toBeDefined();
    expect(errors.AppIdReservedError).toBeDefined();
    expect(errors.GlobalAppError).toBeDefined();
    expect(errors.GlobalDestroyConfirmationError).toBeDefined();
    expect(errors.GlobalServiceCollisionError).toBeDefined();
    expect(errors.GlobalServiceMissingError).toBeDefined();
    expect(errors.GlobalAutoStartError).toBeDefined();
    expect(errors.GlobalDistConflictError).toBeDefined();
    expect(errors.GlobalLandofilePathConflictError).toBeDefined();
    expect(errors.ScratchAppError).toBeDefined();
    expect(errors.ScratchSourceUnresolvedError).toBeDefined();
    expect(errors.ScratchAppNotFoundError).toBeDefined();
    expect(errors.ScratchAppIdInvalidError).toBeDefined();
    expect(errors.ScratchIsolationConflictError).toBeDefined();
    expect(errors.RecipeSourceError).toBeDefined();
    expect(errors.RecipeChoicesError).toBeDefined();
    expect(errors.RecipeRunNotAllowedError).toBeDefined();
    expect(errors.RecipeFetchNotAllowedError).toBeDefined();
    expect(errors.SecretNotFoundError).toBeDefined();
    expect(errors.ConfigTranslateError).toBeDefined();
    expect(errors.ConfigTranslatorConflictError).toBeDefined();
    expect(errors.ConfigTranslateNoTranslatorsError).toBeDefined();
  });

  test("events entry point exports lifecycle event schemas and union", async () => {
    const events = await import("@lando/sdk/events");

    expect(events.PreBootstrapEvent).toBeDefined();
    expect(events.PostBootstrapEvent).toBeDefined();
    expect(events.ReadyEvent).toBeDefined();
    expect(events.BeforeExitEvent).toBeDefined();
    expect(events.PreInitEvent).toBeDefined();
    expect(events.PostInitEvent).toBeDefined();
    expect(events.PreStartEvent).toBeDefined();
    expect(events.PostStartEvent).toBeDefined();
    expect(events.PreStopEvent).toBeDefined();
    expect(events.PostStopEvent).toBeDefined();
    expect(events.PreGlobalStartEvent).toBeDefined();
    expect(events.PostGlobalStartEvent).toBeDefined();
    expect(events.PreGlobalStopEvent).toBeDefined();
    expect(events.PostGlobalStopEvent).toBeDefined();
    expect(events.LandoEvent).toBeDefined();
  });

  test("services entry point exports the canonical Effect service tags", async () => {
    const services = await import("@lando/sdk/services");

    expect(services.Logger).toBeDefined();
    expect(services.ConfigService).toBeDefined();
    expect(services.CacheService).toBeDefined();
    expect(services.EventService).toBeDefined();
    expect(services.LandofileService).toBeDefined();
    expect(services.GlobalAppService).toBeDefined();
    expect(services.ScratchAppService).toBeDefined();
    expect(services.PluginRegistry).toBeDefined();
    expect(services.PluginTrustStore).toBeDefined();
    expect(services.RuntimeProvider).toBeDefined();
    expect(services.RuntimeProviderRegistry).toBeDefined();
    expect(services.FileSystem).toBeDefined();
    expect(services.ProcessRunner).toBeDefined();
    expect(services.ShellRunner).toBeDefined();
    expect(services.ConfigTranslator).toBeDefined();
  });

  test("secrets entry point exports the single value redactor", async () => {
    const secrets = await import("@lando/sdk/secrets");

    expect(secrets.createSecretRedactor).toBeDefined();
    expect(secrets.REDACTED).toBeDefined();
  });

  test("root entry point exposes the Secrets namespace", async () => {
    const sdk = await import("@lando/sdk");

    expect(sdk.Secrets.createSecretRedactor).toBeDefined();
    expect(sdk.Secrets.REDACTED).toBeDefined();
  });

  test("secrets entry point exports the single value-redactor", async () => {
    const secrets = await import("@lando/sdk/secrets");

    expect(secrets.createSecretRedactor).toBeDefined();
    expect(secrets.REDACTED).toBeDefined();
  });

  test("template entry point exports the pluggable engine contract surface", async () => {
    const template = await import("@lando/sdk/template");

    expect(template.TemplateCompileError).toBeDefined();
    expect(template.TemplateRenderError).toBeDefined();
    expect(template.TemplateEngineUnresolvedError).toBeDefined();
  });

  test("test entry point exports provider contract helpers", async () => {
    const sdkTest = await import("@lando/sdk/test");

    expect(sdkTest.runProviderContract).toBeDefined();
    expect(sdkTest.runProviderContractMatrix).toBeDefined();
    expect(sdkTest.TestRuntimeProvider).toBeDefined();
  });

  test("test entry point exports service contract helpers", async () => {
    const sdkTest = await import("@lando/sdk/test");

    expect(sdkTest.runServiceContract).toBeDefined();
    expect(sdkTest.runServiceContractMatrix).toBeDefined();
    expect(sdkTest.TestServiceType).toBeDefined();
  });

  test("test entry point exports plugin contract helpers", async () => {
    const sdkTest = await import("@lando/sdk/test");

    expect(sdkTest.runPluginContract).toBeDefined();
    expect(sdkTest.TestPluginManifest).toBeDefined();
  });
});
