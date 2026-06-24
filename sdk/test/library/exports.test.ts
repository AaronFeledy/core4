import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { Schema } from "effect";

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
    expect(schema.DeprecationNotice).toBeDefined();
    expect(schema.SchemaDeprecationAnnotationId).toBeDefined();
    expect(schema.DeprecationSurfaceKind).toBeDefined();
    expect(schema.DeprecationUse).toBeDefined();
    expect(schema.deprecateField).toBeDefined();
    expect(schema.deprecateSchema).toBeDefined();
    expect(schema.formatDeprecationNotice).toBeDefined();
    expect(schema.getSchemaDeprecation).toBeDefined();
    expect(schema.structuralDeprecationKey).toBeDefined();
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
    expect(schema.ArtifactManifestEntry).toBeDefined();
    expect(schema.DownloadRequest).toBeDefined();
    expect(schema.DownloadResult).toBeDefined();
    expect(schema.DownloaderCapabilities).toBeDefined();
    expect(schema.ArchiveFormat).toBeDefined();
    expect(schema.DataEndpoint).toBeDefined();
    expect(schema.VolumeRef).toBeDefined();
    expect(schema.VolumeInfo).toBeDefined();
    expect(schema.VolumeFilter).toBeDefined();
    expect(schema.VolumeSnapshotSpec).toBeDefined();
    expect(schema.VolumeSnapshotRef).toBeDefined();
    expect(schema.VolumeRestoreSpec).toBeDefined();
    expect(schema.ServiceCopyInSpec).toBeDefined();
    expect(schema.ServiceCopyOutSpec).toBeDefined();
    expect(schema.DataTransferSpec).toBeDefined();
    expect(schema.DataTransferResult).toBeDefined();
    expect(schema.DataTransferProgress).toBeDefined();
    expect(schema.SnapshotHandle).toBeDefined();
    expect(schema.SnapshotInfo).toBeDefined();
    expect(schema.SnapshotFilter).toBeDefined();
    expect(schema.PrunePolicy).toBeDefined();
    expect(schema.SnapshotId).toBeDefined();
    expect(schema.SnapshotOptions).toBeDefined();
    expect(schema.LabelMap).toBeDefined();
    expect(schema.RemoteCapabilities).toBeDefined();
    expect(schema.RemoteConfig).toBeDefined();
    expect(schema.RemoteEnvironment).toBeDefined();
    expect(schema.RemoteEnvId).toBeDefined();
    expect(schema.RemoteLocator).toBeDefined();
    expect(schema.RemoteFetchOptions).toBeDefined();
    expect(schema.RemoteSendOptions).toBeDefined();
    expect(schema.RemoteTestResult).toBeDefined();
    expect(schema.DatasetBinding).toBeDefined();
    expect(schema.RemoteSourceContribution).toBeDefined();
    expect(schema.DatasetKind).toBeDefined();
    expect(schema.DatasetContribution).toBeDefined();
    expect(schema.DatasetCapabilities).toBeDefined();
    expect(schema.DatasetArtifactFormat).toBeDefined();
    expect(schema.DatasetContext).toBeDefined();
    expect(schema.DatasetCaptureOptions).toBeDefined();
    expect(schema.DatasetApplyOptions).toBeDefined();
    expect(schema.DatasetApplyResult).toBeDefined();
    expect(schema.SyncResult).toBeDefined();
    expect(schema.TunnelCapabilities).toBeDefined();
    expect(schema.TunnelTarget).toBeDefined();
    expect(schema.TunnelStartRequest).toBeDefined();
    expect(schema.TunnelStopRequest).toBeDefined();
    expect(schema.TunnelStatusRequest).toBeDefined();
    expect(schema.TunnelSession).toBeDefined();
    expect(schema.TunnelStatus).toBeDefined();
    expect(schema.TunnelSessionFilter).toBeDefined();
    expect(schema.TunnelServiceContribution).toBeDefined();
    expect(schema.FileFormat).toBeDefined();
    expect(schema.ContentSource).toBeDefined();
    expect(schema.ManagedFile).toBeDefined();
    expect(schema.ManagedFileAction).toBeDefined();
    expect(schema.ManagedFileInfo).toBeDefined();
    expect(schema.ManagedFilePlan).toBeDefined();
    expect(schema.ManagedFileResult).toBeDefined();
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
    expect(schema.PromptType).toBeDefined();
    expect(schema.PromptSpec).toBeDefined();
    expect(schema.PromptChoice).toBeDefined();
    expect(schema.PromptValidate).toBeDefined();
    expect(schema.PromptAnswer).toBeDefined();
    expect(schema.ChoicesFrom).toBeDefined();
    expect(schema.InteractionServiceContribution).toBeDefined();
    expect(schema.Transcript).toBeDefined();
    expect(schema.getJsonSchema).toBeDefined();
    expect(schema.assertPublicSchemaAnnotations).toBeDefined();
    expect(schema.publicSchemaRegistry).toBeDefined();
    expect(schema.publicSchemaMetadataIndex).toBeDefined();
    expect(schema.renderPublicSchemaReferencePages).toBeDefined();
    expect(schema.schemaArtifactFilename).toBeDefined();
    expect(schema.validatePublicSchemaAnnotations).toBeDefined();
    expect(schema.getJsonSchemaWithDeprecations).toBeDefined();
    expect(schema.renderSchemaReferenceMarkdown).toBeDefined();
  });

  test("schema entry point exposes JSON Schema for the canonical contract surface", async () => {
    const schema = await import("@lando/sdk/schema");

    for (const schemaName of [
      "BootstrapLevel",
      "DeprecationNotice",
      "DeprecationUse",
      "AppRef",
      "AppPlan",
      "ServicePlan",
      "ProviderCapabilities",
      "LandofileShape",
      "GlobalConfig",
      "ConfigLintViolation",
      "ConfigLintResult",
      "ManagedFile",
      "ManagedFileInfo",
      "ManagedFilePlan",
      "ManagedFileResult",
      "AppId",
      "ServiceName",
      "ProviderId",
      "HostPlatform",
      "ServiceInfo",
      "PluginManifest",
      "Transcript",
      "ServiceConfig",
      "RouteInput",
      "HealthcheckInput",
      "ToolingTaskShape",
      "ExpressionTemplate",
      "ExpressionNode",
      "LandofileExpressionParseError",
      "LandofileExpressionForbiddenError",
      "LandofileExpressionEvalError",
      "LandoEvent",
      "PreBootstrapEvent",
      "DeprecationUsedEvent",
      "TaskDetailEvent",
      "RemoteCapabilities",
      "RemoteConfig",
      "RemoteEnvironment",
      "RemoteEnvId",
      "RemoteLocator",
      "RemoteFetchOptions",
      "RemoteSendOptions",
      "RemoteTestResult",
      "DatasetBinding",
      "DatasetKind",
      "DatasetCapabilities",
      "DatasetArtifactFormat",
      "DatasetContext",
      "DatasetCaptureOptions",
      "DatasetApplyOptions",
      "DatasetApplyResult",
      "SyncResult",
      "TunnelCapabilities",
      "TunnelTarget",
      "TunnelStartRequest",
      "TunnelStopRequest",
      "TunnelStatusRequest",
      "TunnelSession",
      "TunnelStatus",
      "TunnelSessionFilter",
    ] as const) {
      const jsonSchema = schema.getJsonSchema(schemaName) as { readonly $schema?: unknown };

      expect(jsonSchema).toBeDefined();
      expect(jsonSchema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    }
  });

  test("core schema re-exports the canonical deprecation notice", async () => {
    const sdkSchema = await import("@lando/sdk/schema");
    const coreSchema = await import("@lando/core/schema");
    const notice = {
      since: "4.1.0",
      removeIn: "5.0.0",
      replacement: "new-command",
      docsUrl: "https://docs.lando.dev/deprecations/new-command",
      note: "Use new-command instead.",
    };

    expect(Schema.decodeUnknownSync(coreSchema.DeprecationNotice)(notice)).toEqual(
      Schema.decodeUnknownSync(sdkSchema.DeprecationNotice)(notice),
    );
    expect(coreSchema.getJsonSchema("DeprecationNotice")).toEqual(
      sdkSchema.getJsonSchema("DeprecationNotice"),
    );
    expect(coreSchema.publicSchemaRegistry).toHaveProperty("DeprecationNotice");
    expect(coreSchema.publicSchemaMetadataIndex.find((entry) => entry.id === "DeprecationNotice")).toEqual(
      sdkSchema.publicSchemaMetadataIndex.find((entry) => entry.id === "DeprecationNotice"),
    );
    expect(coreSchema.renderPublicSchemaReferencePages()).toEqual(
      sdkSchema.renderPublicSchemaReferencePages(),
    );
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
    expect(errors.ManagedFileError).toBeDefined();
    expect(errors.DownloadFetchError).toBeDefined();
    expect(errors.DownloadChecksumError).toBeDefined();
    expect(errors.DownloadSizeMismatchError).toBeDefined();
    expect(errors.DownloadPersistError).toBeDefined();
    expect(errors.DownloadOfflineError).toBeDefined();
    expect(errors.DownloadSourceForbiddenError).toBeDefined();
    expect(errors.DownloaderUnavailableError).toBeDefined();
    expect(errors.DataTransferError).toBeDefined();
    expect(errors.DataEndpointUnsupportedError).toBeDefined();
    expect(errors.DataChecksumMismatchError).toBeDefined();
    expect(errors.DataSourceOutsideRootError).toBeDefined();
    expect(errors.DataTargetExistsError).toBeDefined();
    expect(errors.SnapshotNotFoundError).toBeDefined();
    expect(errors.VolumeNotFoundError).toBeDefined();
    expect(errors.ArchiveFormatError).toBeDefined();
    expect(errors.RemoteError).toBeDefined();
    expect(errors.RemoteUnreachableError).toBeDefined();
    expect(errors.RemoteAuthError).toBeDefined();
    expect(errors.RemoteEnvNotFoundError).toBeDefined();
    expect(errors.RemoteDatasetUnsupportedError).toBeDefined();
    expect(errors.RemoteProviderUnavailableError).toBeDefined();
    expect(errors.RemoteProtectedEnvError).toBeDefined();
    expect(errors.RemoteToolMissingError).toBeDefined();
    expect(errors.DatasetError).toBeDefined();
    expect(errors.DatasetCaptureError).toBeDefined();
    expect(errors.DatasetApplyError).toBeDefined();
    expect(errors.DatasetBindingError).toBeDefined();
    expect(errors.TunnelProviderUnavailableError).toBeDefined();
    expect(errors.TunnelTargetUnresolvedError).toBeDefined();
    expect(errors.TunnelAuthRequiredError).toBeDefined();
    expect(errors.TunnelStartError).toBeDefined();
    expect(errors.TunnelReadyTimeoutError).toBeDefined();
    expect(errors.TunnelDetachedStateError).toBeDefined();
    expect(errors.TunnelStopError).toBeDefined();
    expect(errors.VolumeOperationError).toBeDefined();
    expect(errors.ServiceCopyError).toBeDefined();
    expect(errors.ArtifactTransferError).toBeDefined();
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
    expect(errors.AppResolveError).toBeDefined();
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
    expect(errors.InteractionRequiredError).toBeDefined();
    expect(errors.PromptValidationError).toBeDefined();
    expect(errors.InteractionCancelledError).toBeDefined();
    expect(errors.ChoicesUnavailableError).toBeDefined();
    expect(errors.InteractionUnavailableError).toBeDefined();
    expect(errors.RecipeRunNotAllowedError).toBeDefined();
    expect(errors.RecipeFetchNotAllowedError).toBeDefined();
    expect(errors.SecretNotFoundError).toBeDefined();
    expect(errors.ConfigTranslateError).toBeDefined();
    expect(errors.ConfigTranslatorConflictError).toBeDefined();
    expect(errors.ConfigTranslateNoTranslatorsError).toBeDefined();
    expect(errors.DeprecatedSurfaceError).toBeDefined();
    expect(errors.DeprecationContradictionError).toBeDefined();
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
    expect(events.PreManagedFileWriteEvent).toBeDefined();
    expect(events.PostManagedFileWriteEvent).toBeDefined();
    expect(events.ManagedFileConflictDetectedEvent).toBeDefined();
    expect(events.ManagedFileSkippedEvent).toBeDefined();
    expect(events.PreDownloadEvent).toBeDefined();
    expect(events.DownloadProgressEvent).toBeDefined();
    expect(events.PostDownloadEvent).toBeDefined();
    expect(events.PrePullEvent).toBeDefined();
    expect(events.PostPullEvent).toBeDefined();
    expect(events.PrePushEvent).toBeDefined();
    expect(events.PostPushEvent).toBeDefined();
    expect(events.PreDatasetFetchEvent).toBeDefined();
    expect(events.PostDatasetFetchEvent).toBeDefined();
    expect(events.PreDatasetApplyEvent).toBeDefined();
    expect(events.PostDatasetApplyEvent).toBeDefined();
    expect(events.PreDatasetCaptureEvent).toBeDefined();
    expect(events.PostDatasetCaptureEvent).toBeDefined();
    expect(events.PreDatasetSendEvent).toBeDefined();
    expect(events.PostDatasetSendEvent).toBeDefined();
    expect(events.PreTunnelStartEvent).toBeDefined();
    expect(events.PostTunnelStartEvent).toBeDefined();
    expect(events.TunnelReadyEvent).toBeDefined();
    expect(events.PreTunnelStopEvent).toBeDefined();
    expect(events.PostTunnelStopEvent).toBeDefined();
    expect(events.TunnelStatusEvent).toBeDefined();
    expect(events.DeprecationUsedEvent).toBeDefined();
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
    expect(services.ManagedFileService).toBeDefined();
    expect(services.InteractionService).toBeDefined();
    expect(services.DeprecationService).toBeDefined();
    expect(services.markDeprecated).toBeDefined();
    expect(services.PluginRegistry).toBeDefined();
    expect(services.PluginTrustStore).toBeDefined();
    expect(services.RuntimeProvider).toBeDefined();
    expect(services.RuntimeProviderRegistry).toBeDefined();
    expect(services.FileSystem).toBeDefined();
    expect(services.ProcessRunner).toBeDefined();
    expect(services.ShellRunner).toBeDefined();
    expect(services.ConfigTranslator).toBeDefined();
    expect(services.Downloader).toBeDefined();
    expect(services.DataMover).toBeDefined();
    expect(services.PathsService).toBeDefined();
    expect(services.RemoteSource).toBeDefined();
    expect(services.Dataset).toBeDefined();
    expect(services.TunnelService).toBeDefined();
  });

  test("secrets entry point exports the canonical redaction primitive", async () => {
    const secrets = await import("@lando/sdk/secrets");

    expect(secrets.createSecretRedactor).toBeDefined();
    expect(secrets.REDACTED).toBeDefined();
    expect(secrets.createRedactor).toBeDefined();
    expect(secrets.REDACTION_PROFILES).toBeDefined();
    expect(secrets.PATTERN_CLASSES).toBeDefined();
  });

  test("root entry point exposes the Secrets namespace", async () => {
    const sdk = await import("@lando/sdk");

    expect(sdk.Secrets.createSecretRedactor).toBeDefined();
    expect(sdk.Secrets.REDACTED).toBeDefined();
    expect(sdk.Secrets.createRedactor).toBeDefined();
    expect(sdk.Secrets.REDACTION_PROFILES).toBeDefined();
  });

  test("@lando/core/secrets re-exports the @lando/sdk/secrets primitive", async () => {
    const coreSecrets = await import("@lando/core/secrets");

    expect(coreSecrets.createRedactor).toBeDefined();
    expect(coreSecrets.createSecretRedactor).toBeDefined();
    expect(coreSecrets.REDACTED).toBe("[redacted]");
  });

  test("template entry point exports the pluggable engine contract surface", async () => {
    const template = await import("@lando/sdk/template");

    expect(template.TemplateCompileError).toBeDefined();
    expect(template.TemplateRenderError).toBeDefined();
    expect(template.TemplateEngineUnresolvedError).toBeDefined();
  });

  test("landofile entry point exports the canonical serializer pair", async () => {
    const landofile = await import("@lando/sdk/landofile");

    expect(landofile.emitLandofileYaml).toBeDefined();
    expect(landofile.emitLandofileYamlEither).toBeDefined();
    expect(landofile.parseLandofile).toBeDefined();
    expect(landofile.LandofileEmitError).toBeDefined();
  });

  test("verified-stream entry point exports the shared hash-and-persist helper", async () => {
    const verifiedStream = await import("@lando/sdk/verified-stream");

    expect(verifiedStream.persistVerifiedStream).toBeDefined();
    expect(verifiedStream.collectVerifiedStream).toBeDefined();
    expect(verifiedStream.VerifiedStreamError).toBeDefined();
  });

  test("app entry point resolves (type-only App handle contracts)", async () => {
    const app = await import("@lando/sdk/app");

    expect(app).toBeDefined();
  });

  test("test entry point exports provider contract helpers", async () => {
    const sdkTest = await import("@lando/sdk/test");

    expect(sdkTest.runProviderContract).toBeDefined();
    expect(sdkTest.runProviderContractMatrix).toBeDefined();
    expect(sdkTest.runProviderDataPlaneContract).toBeDefined();
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

  test("test entry point exports the managed-file contract suite", async () => {
    const sdkTest = await import("@lando/sdk/test");

    expect(sdkTest.runManagedFileContract).toBeDefined();
  });

  test("test entry point exports the downloader contract suite", async () => {
    const sdkTest = await import("@lando/sdk/test");

    expect(sdkTest.runDownloaderContract).toBeDefined();
  });

  test("test entry point exports the remote-sync contract suites", async () => {
    const sdkTest = await import("@lando/sdk/test");

    expect(sdkTest.runRemoteSourceContract).toBeDefined();
    expect(sdkTest.runDatasetContract).toBeDefined();
    expect(sdkTest.makeRemoteSourceContractSuite).toBeDefined();
    expect(sdkTest.makeDatasetContractSuite).toBeDefined();
  });

  test("test entry point exports the tunnel contract suite", async () => {
    const sdkTest = await import("@lando/sdk/test");

    expect(sdkTest.runTunnelServiceContract).toBeDefined();
    expect(sdkTest.makeTunnelServiceContractSuite).toBeDefined();
  });

  test("test entry point exports the interaction contract suite", async () => {
    const sdkTest = await import("@lando/sdk/test");

    expect(sdkTest.runInteractionContract).toBeDefined();
    expect(sdkTest.makeInteractionContractRenderer).toBeDefined();
  });

  test("test entry point exports the redaction contract suite and fixture", async () => {
    const sdkTest = await import("@lando/sdk/test");

    expect(sdkTest.runRedactionContract).toBeDefined();
    expect(sdkTest.SECRET_SOUP_FIXTURE).toBeDefined();
  });

  test("test entry point documents plugin contract runner arguments", async () => {
    const source = await readFile(new URL("../../src/test/index.ts", import.meta.url), "utf8");

    const docblock = source.match(/\/\*\*\s*\n \* runPluginContract arguments:[\s\S]*?\n \*\//)?.[0];

    expect(docblock).toBeDefined();
    expect(docblock).toMatch(/^ \* - manifest: decoded or encoded plugin manifest object to validate\.$/m);
    expect(docblock).toMatch(/^ \* - layers: static Layer exports keyed by contribution kind/m);
    expect(docblock).toMatch(
      /^ \* - globalServices: static global-service map keyed by contributed service id\.$/m,
    );
    expect(docblock).toMatch(
      /^ \* - serviceTypes: static service-type map keyed by contributed service type id\.$/m,
    );
    expect(docblock).toMatch(
      /^ \* - templateEngines: static template-engine map keyed by contributed engine id\.$/m,
    );
  });
});
