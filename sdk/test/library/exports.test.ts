import { describe, expect, test } from "bun:test";

describe("@lando/sdk package exports", () => {
  test("root entry point resolves the public namespaces", async () => {
    const sdk = await import("@lando/sdk");

    expect(sdk.Schema.BootstrapLevel).toBeDefined();
    expect(sdk.Errors.LandoRuntimeBootstrapError).toBeDefined();
    expect(sdk.Events.LandoEvent).toBeDefined();
    expect(sdk.Services.RuntimeProvider).toBeDefined();
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
    expect(schema.GlobalConfig).toBeDefined();
    expect(schema.AppId).toBeDefined();
    expect(schema.ServiceName).toBeDefined();
    expect(schema.ProviderId).toBeDefined();
    expect(schema.HostPlatform).toBeDefined();
    expect(schema.ServiceInfo).toBeDefined();
    expect(schema.PluginManifest).toBeDefined();
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
      "AppId",
      "ServiceName",
      "ProviderId",
      "HostPlatform",
      "ServiceInfo",
      "PluginManifest",
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
    expect(events.LandoEvent).toBeDefined();
  });

  test("services entry point exports the canonical Effect service tags", async () => {
    const services = await import("@lando/sdk/services");

    expect(services.Logger).toBeDefined();
    expect(services.ConfigService).toBeDefined();
    expect(services.CacheService).toBeDefined();
    expect(services.EventService).toBeDefined();
    expect(services.LandofileService).toBeDefined();
    expect(services.PluginRegistry).toBeDefined();
    expect(services.RuntimeProvider).toBeDefined();
    expect(services.RuntimeProviderRegistry).toBeDefined();
    expect(services.FileSystem).toBeDefined();
    expect(services.ProcessRunner).toBeDefined();
    expect(services.ShellRunner).toBeDefined();
  });

  test("test entry point exports provider contract helpers", async () => {
    const sdkTest = await import("@lando/sdk/test");

    expect(sdkTest.runProviderContract).toBeDefined();
    expect(sdkTest.TestRuntimeProvider).toBeDefined();
  });
});
