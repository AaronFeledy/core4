import { RedactionService } from "@lando/redaction/service";
/**
 * `lando meta:setup` prepares the host provider, CA, router, and shell integration.
 *
 * Provider precedence is flag, environment, configuration, interactive choice, default.
 */
import { Effect, Schema } from "effect";
import type * as HttpClient from "effect/http/HttpClient";

import { AppPlacementError } from "@lando/sdk/errors";
import {
  ConfigService,
  type Downloader,
  GlobalAppService,
  InteractionService,
  PrivilegeService,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import { config as writeConfig } from "@lando/engine/operations/config";
import {
  SetupProviderSwitchResultSchema,
  switchGlobalProviderForSetup,
} from "@lando/engine/operations/setup-provider-switch";
import { ensureAppPlacement } from "@lando/engine/providers/app-placement";
import { HostProviderOverride } from "@lando/engine/providers/host-provider";
import {
  CAPABILITY_DEFAULT_PROVIDER_ID,
  readProviderEnvVar,
  resolveProviderSelection,
} from "@lando/engine/providers/precedence";
import { GlobalConfigSources } from "@lando/engine/services/config";
import { HostProxyServiceDisabled } from "@lando/engine/subsystems/host-proxy/api";
import { NetworkTrust } from "@lando/http-client/network-trust";
import { formatSummary } from "@lando/renderer/summary";
import { networkTrustFromResolved, validateSetupNetworkTrust } from "../../commands/setup-network-trust";
import { ShellenvInstallRecordError, installShellProfileIntegration } from "../../commands/shellenv";
import { isDecoratedContext, summaryPaintOptions } from "../../renderer-boundary";

import type { LandoCommandSpec } from "../../spec/command-base";
import { SETUP_COMMAND_FLAGS, contributedSetupFlagsForProvider } from "./setup-command-flags";
import {
  type SetupResult,
  SetupResultSchema,
  inputBooleanFlag,
  inputInstallDir,
  inputNetworkProbe,
  inputProviderFlag,
  inputStringFlag,
  shouldDisableHostProxyForSetup,
  sourceInstallDir,
} from "./setup-inputs";
import { authorizeProviderSetupPlan } from "./setup-provider-authorization";
import {
  SYSTEM_RUNTIME_PROVIDERS,
  maybeSelectSetupProvider,
  setupProviderPlan,
  systemRuntimeUnavailableError,
} from "./setup-provider-selection";
import { runCaSetupStep, runProxySetupStep, runShellServiceSetupStep } from "./setup-service-steps";
import {
  SetupStepFailedError,
  ShellProfileIntegrationError,
  makeSetupReadinessRecorder,
  runFileSyncSetupStep,
  runtimeServiceReadinessFor,
} from "./setup-steps";
import { buildSetupSummary, caInjectionNote, fileSyncStatusLine } from "./setup-summary";

export { SetupResultSchema, shouldDisableHostProxyForSetup } from "./setup-inputs";
export { maybeSelectSetupProvider } from "./setup-provider-selection";
export { SetupStepFailedError, ShellProfileIntegrationError, setupDeferredFileSyncPath } from "./setup-steps";

export const setupSpec: LandoCommandSpec<
  SetupResult,
  unknown,
  | ConfigService
  | GlobalConfigSources
  | RuntimeProviderRegistry
  | HttpClient.HttpClient
  | Downloader
  | InteractionService
> = {
  resultSchema: SetupResultSchema,
  id: "meta:setup",
  helpGroup: "common",
  summary: "Run host setup (provider, CA, router, shell integration).",
  description: "Run provider, CA, router, and shell-integration setup.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "provider",
  flags: SETUP_COMMAND_FLAGS,
  run: Effect.fn("SetupCommand.run")(function* (input: unknown) {
    const configService = yield* ConfigService;
    const registry = yield* RuntimeProviderRegistry;
    const globalConfig = yield* configService.load;

    const flag = inputProviderFlag(input);
    const captured = yield* Effect.serviceOption(GlobalConfigSources);
    const env = readProviderEnvVar(
      captured._tag === "None" ? process.env : captured.value.sources.env ? captured.value.env : {},
    );
    const configRaw = globalConfig.defaultProviderId;
    const config = configRaw ?? undefined;

    const resolution = resolveProviderSelection({
      ...(flag === undefined ? {} : { flag }),
      ...(env === undefined ? {} : { env }),
      ...(config === undefined ? {} : { config }),
      capabilityDefault: CAPABILITY_DEFAULT_PROVIDER_ID,
    });

    const interactionOption = yield* Effect.serviceOption(InteractionService);
    const interaction = interactionOption._tag === "Some" ? interactionOption.value : undefined;

    const selection = yield* maybeSelectSetupProvider({
      resolution,
      yes: inputBooleanFlag(input, "yes"),
      nonInteractive: inputBooleanFlag(input, "no-interactive"),
      skipProvider: inputBooleanFlag(input, "skip-provider"),
      ...(interaction === undefined ? {} : { interaction }),
    });

    const selectedProvider = selection.providerId;
    const persistsSelection =
      !inputBooleanFlag(input, "skip-provider") &&
      (selection.source === "flag" || selection.source === "prompt");
    if (!persistsSelection) {
      const globalApp = yield* Effect.serviceOption(GlobalAppService);
      if (globalApp._tag === "Some") {
        const { root } = yield* globalApp.value.paths;
        yield* ensureAppPlacement({ kind: "global", id: "global", root }, selectedProvider).pipe(
          Effect.mapError((error) =>
            error instanceof AppPlacementError
              ? new AppPlacementError({
                  app: error.app,
                  message: error.message,
                  desiredProviderId: error.desiredProviderId,
                  realizedProviderId: error.realizedProviderId,
                  remediation: `Run \`lando setup --provider=${selectedProvider}\` to switch persistently, or unset \`LANDO_PROVIDER\` to keep the existing provider.`,
                })
              : error,
          ),
        );
      }
    }
    const withHostProvider = Effect.provideService(HostProviderOverride, selectedProvider);
    const provider = yield* registry.select(setupProviderPlan(selectedProvider));
    const networkProbe = inputNetworkProbe(input);
    const privilege = yield* Effect.serviceOption(PrivilegeService);
    const privilegeOptions = privilege._tag === "Some" ? { privilege: privilege.value } : {};

    const selectedProviderId = String(selectedProvider);
    const userDataRootRaw = globalConfig.userDataRoot;
    const userDataRoot =
      typeof userDataRootRaw === "string" && userDataRootRaw.length > 0 ? userDataRootRaw : undefined;
    const redaction = yield* Effect.serviceOption(RedactionService);
    const recorder = makeSetupReadinessRecorder(
      userDataRoot,
      selectedProviderId,
      redaction._tag === "Some" ? redaction.value : undefined,
    );
    const network = yield* validateSetupNetworkTrust(globalConfig, networkProbe).pipe(
      Effect.tapError((cause) => recorder.recordFailure("network", cause)),
    );

    const shouldPersistProvider =
      (selection.source === "flag" || selection.source === "prompt") && selectedProvider !== config;

    if (!inputBooleanFlag(input, "skip-provider")) {
      if (selectedProviderId in SYSTEM_RUNTIME_PROVIDERS) {
        const available = yield* provider.isAvailable.pipe(
          Effect.tapError((cause) => recorder.recordFailure("provider", cause)),
        );
        if (!available) {
          const error = systemRuntimeUnavailableError(selectedProviderId);
          yield* recorder.recordFailure("provider", error);
          return yield* Effect.fail(error);
        }
      }
      const runtimeBundleUrl = inputStringFlag(input, "runtime-bundle-url");
      const runtimeBundleSha256 = inputStringFlag(input, "runtime-bundle-sha256");
      const setupFlags = contributedSetupFlagsForProvider(input, selectedProviderId);
      const inspectOptions = {
        force: false,
        network,
        ...(runtimeBundleUrl === undefined ? {} : { runtimeBundleUrl }),
        ...(runtimeBundleSha256 === undefined ? {} : { runtimeBundleSha256 }),
        ...(Object.keys(setupFlags).length === 0 ? {} : { setupFlags }),
      };
      const plan = yield* provider
        .planSetup(inspectOptions)
        .pipe(Effect.tapError((cause) => recorder.recordFailure("provider", cause)));
      const approvedPlan = yield* authorizeProviderSetupPlan(plan, {
        yes: inputBooleanFlag(input, "yes"),
        nonInteractive: inputBooleanFlag(input, "no-interactive"),
        interaction,
      }).pipe(Effect.tapError((cause) => recorder.recordFailure("provider", cause)));
      yield* Effect.scoped(
        provider.setup(approvedPlan, {
          ...inspectOptions,
          ...privilegeOptions,
        }),
      ).pipe(
        Effect.provideService(NetworkTrust, networkTrustFromResolved(network)),
        Effect.tapError((cause) => recorder.recordFailure("provider", cause)),
      );
      recorder.setRuntimeService(yield* runtimeServiceReadinessFor(provider));
      yield* recorder.record({
        id: "provider",
        status: "satisfied",
        evidence: `Provider ${selectedProviderId} setup completed.`,
      });
    } else {
      yield* recorder.record({
        id: "provider",
        status: "skipped",
        evidence: `Provider ${selectedProviderId} setup skipped by --skip-provider.`,
      });
    }

    const providerSwitch = yield* switchGlobalProviderForSetup(selectedProvider).pipe(
      Effect.tapError((cause) => recorder.recordFailure("provider", cause)),
    );
    if (!inputBooleanFlag(input, "skip-provider") && shouldPersistProvider) {
      yield* writeConfig({ subcommand: "set", key: "defaultProviderId", value: selectedProviderId }).pipe(
        Effect.tapError((cause) => recorder.recordFailure("provider", cause)),
      );
    }
    yield* runCaSetupStep(input, privilegeOptions, recorder, selectedProviderId).pipe(withHostProvider);
    yield* runProxySetupStep(input, recorder, selectedProviderId).pipe(withHostProvider);
    yield* runShellServiceSetupStep(input, recorder, selectedProviderId).pipe(withHostProvider);

    if (shouldDisableHostProxyForSetup(input)) {
      yield* HostProxyServiceDisabled.setup({ mode: "none" });
    }

    if (
      process.platform !== "win32" &&
      !inputBooleanFlag(input, "skip-shell-integration") &&
      !inputBooleanFlag(input, "no-interactive") &&
      privilege._tag === "Some" &&
      userDataRoot !== undefined
    ) {
      const shellProfile = yield* Effect.try({
        try: () => installShellProfileIntegration(userDataRoot, privilege.value),
        catch: (cause) => {
          if (!(cause instanceof ShellenvInstallRecordError)) throw cause;
          return new ShellProfileIntegrationError({
            message: "Shell profile integration failed.",
            stderr: cause.message,
            remediation:
              "Fix shell profile write permissions, then rerun `lando setup` or `lando shellenv` to finish PATH integration.",
          });
        },
      }).pipe(
        Effect.flatten,
        Effect.tapError((cause) => recorder.recordFailure("shell", cause.stderr)),
      );
      if (shellProfile.exitCode !== 0) {
        yield* recorder.recordFailure("shell", shellProfile.stderr);
        return yield* Effect.fail(
          new ShellProfileIntegrationError({
            message: "Shell profile integration failed.",
            stderr: shellProfile.stderr,
            remediation:
              "Fix shell profile write permissions, then rerun `lando setup` or `lando shellenv` to finish PATH integration.",
          }),
        );
      }
    }

    const fileSyncStatus = yield* runFileSyncSetupStep({
      provider,
      input,
      userDataRoot,
      network,
      recorder,
    }).pipe(withHostProvider);

    const failedStep = recorder.firstFailedStep();
    if (failedStep !== undefined) {
      const setupCommand =
        selectedProviderId in SYSTEM_RUNTIME_PROVIDERS
          ? `lando setup --provider=${selectedProviderId}`
          : "lando setup";
      return yield* Effect.fail(
        new SetupStepFailedError({
          stepId: failedStep.id,
          message: failedStep.evidence,
          remediation: failedStep.remediation ?? `Rerun \`${setupCommand}\` to resume host setup.`,
        }),
      );
    }

    const networkCaInjectionConfigured = network.ca.injectIntoServices && network.ca.loadedCerts.length > 0;

    return {
      providerId: provider.id,
      installDir: inputInstallDir(input) ?? sourceInstallDir(),
      fileSyncStatus,
      networkCaInjectionConfigured,
      ...(providerSwitch === undefined ? {} : { providerSwitch }),
    };
  }),
  render: (result, _input, ctx) => {
    if (
      typeof result !== "object" ||
      result === null ||
      !("providerId" in result) ||
      !("installDir" in result) ||
      !("networkCaInjectionConfigured" in result) ||
      typeof result.networkCaInjectionConfigured !== "boolean"
    ) {
      return undefined;
    }
    const status = "fileSyncStatus" in result ? String(result.fileSyncStatus) : "satisfied";
    const providerId = String(result.providerId);
    const installDir = String(result.installDir);
    const notes = result.networkCaInjectionConfigured ? [caInjectionNote] : [];
    if ("providerSwitch" in result && Schema.is(SetupProviderSwitchResultSchema)(result.providerSwitch)) {
      const switched = result.providerSwitch;
      notes.push(
        `Global services switched from ${switched.fromProviderId} to ${switched.toProviderId}; old volumes and router configuration were kept.`,
      );
      for (const app of switched.remainingApps)
        notes.push(
          `${app.id} remains on ${switched.fromProviderId}. In ${app.root}, run \`lando destroy --provider=${switched.fromProviderId} --yes\`, then \`lando start\`. A Landofile \`provider:\` still pins the app. Data volumes are not copied.`,
        );
    }
    if (process.platform === "win32") {
      notes.push(
        "To keep Lando on PATH in new PowerShell sessions, create `$PROFILE` if needed, then append the output of `lando shellenv --shell=powershell` to it. Keep any existing profile content.",
      );
    }
    if (isDecoratedContext(ctx))
      return formatSummary(
        buildSetupSummary({ providerId, installDir, fileSyncStatus: status, notes }),
        summaryPaintOptions(ctx),
      );
    const completion = `setup complete: Lando runtime (${providerId})\n${fileSyncStatusLine(status)}\nLANDO_INSTALL_DIR="${installDir}"`;
    return notes.length === 0 ? completion : `${completion}\n${notes.join("\n")}`;
  },
};
