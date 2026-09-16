/**
 * `lando meta:setup` prepares the host provider, CA, router, and shell integration.
 *
 * Setup ignores leftover `defaultProviderId` in user config so a last-used
 * system runtime cannot poison `lando setup` / `lando setup --yes`. Effective
 * setup precedence is `--provider > LANDO_PROVIDER > capability default (lando)`.
 * App commands may still honor leftover config as a last-used hint.
 */
import { Effect, Either } from "effect";

import {
  ConfigService,
  type Downloader,
  type HttpClient,
  InteractionService,
  PrivilegeService,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicViaRename } from "@lando/engine/cache/atomic";
import { emitConfigYaml } from "@lando/engine/config-write/write-core";
import { resolveUserConfRoot } from "@lando/engine/config/roots";
import {
  CAPABILITY_DEFAULT_PROVIDER_ID,
  readProviderEnvVar,
  resolveProviderSelection,
} from "@lando/engine/providers/precedence";
import { HostProxyServiceDisabled } from "@lando/engine/subsystems/host-proxy/api";
import { NetworkTrust } from "@lando/http-client/network-trust";
import { parseMinimalYaml } from "@lando/paths/yaml-min";
import { formatSummary } from "@lando/renderer/summary";
import { networkTrustFromResolved, validateSetupNetworkTrust } from "../../commands/setup-network-trust";
import { installShellProfileIntegration } from "../../commands/shellenv";
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

const writeConfigDefaultProvider = (providerId: string): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const confRoot = resolveUserConfRoot();
    const configPath = join(confRoot, "config.yml");

    try {
      const existing = existsSync(configPath) ? readFileSync(configPath, "utf-8") : "";
      const tree = existing.length > 0 ? (parseMinimalYaml(existing) as Record<string, unknown>) : {};
      tree.defaultProviderId = providerId;
      const emitted = emitConfigYaml({ file: configPath, value: tree, path: "defaultProviderId" });
      if (Either.isLeft(emitted)) return;
      mkdirSync(confRoot, { recursive: true });
      yield* Effect.promise(() => writeFileAtomicViaRename(configPath, emitted.right));
    } catch {
      // Silently fail - config persistence is optional
    }
  }).pipe(Effect.catchAll(() => Effect.void));

export const setupSpec: LandoCommandSpec<
  SetupResult,
  unknown,
  ConfigService | RuntimeProviderRegistry | HttpClient | Downloader | InteractionService
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
  run: (input) =>
    Effect.gen(function* () {
      const configService = yield* ConfigService;
      const registry = yield* RuntimeProviderRegistry;
      const globalConfig = yield* configService.load;

      const flag = inputProviderFlag(input);
      const env = readProviderEnvVar(process.env);
      const configRaw = globalConfig.defaultProviderId;
      const config = configRaw ?? undefined;

      const resolution = resolveProviderSelection({
        ...(flag === undefined ? {} : { flag }),
        ...(env === undefined ? {} : { env }),
        capabilityDefault: CAPABILITY_DEFAULT_PROVIDER_ID,
      });

      const interactionOption = yield* Effect.serviceOption(InteractionService);
      const interaction = interactionOption._tag === "Some" ? interactionOption.value : undefined;

      const selectedProvider = yield* maybeSelectSetupProvider({
        resolution,
        yes: inputBooleanFlag(input, "yes"),
        nonInteractive: inputBooleanFlag(input, "no-interactive"),
        skipProvider: inputBooleanFlag(input, "skip-provider"),
        ...(interaction === undefined ? {} : { interaction }),
      });

      const provider = yield* registry.select(setupProviderPlan(selectedProvider));
      const networkProbe = inputNetworkProbe(input);
      const privilege = yield* Effect.serviceOption(PrivilegeService);
      const privilegeOptions = privilege._tag === "Some" ? { privilege: privilege.value } : {};

      const selectedProviderId = String(selectedProvider);
      const userDataRootRaw = globalConfig.userDataRoot;
      const userDataRoot =
        typeof userDataRootRaw === "string" && userDataRootRaw.length > 0 ? userDataRootRaw : undefined;
      const recorder = makeSetupReadinessRecorder(userDataRoot, selectedProviderId);
      const network = yield* validateSetupNetworkTrust(globalConfig, networkProbe).pipe(
        Effect.tapError((cause) => recorder.recordFailure("network", cause)),
      );

      // Persist an explicit --provider as a last-used hint for doctor / start /
      // planner / app commands. Setup itself still ignores leftover
      // defaultProviderId so a later `lando setup --yes` stays on lando.
      const shouldPersistProvider = flag !== undefined && flag !== config;

      if (!inputBooleanFlag(input, "skip-provider")) {
        if (selectedProviderId in SYSTEM_RUNTIME_PROVIDERS) {
          const available = yield* provider.isAvailable;
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

        if (shouldPersistProvider) {
          yield* writeConfigDefaultProvider(selectedProviderId);
        }
      } else {
        yield* recorder.record({
          id: "provider",
          status: "skipped",
          evidence: `Provider ${selectedProviderId} setup skipped by --skip-provider.`,
        });
      }

      yield* runCaSetupStep(input, privilegeOptions, recorder, selectedProviderId);
      yield* runProxySetupStep(input, recorder, selectedProviderId);
      yield* runShellServiceSetupStep(input, recorder, selectedProviderId);

      if (shouldDisableHostProxyForSetup(input)) {
        yield* HostProxyServiceDisabled.setup({ mode: "none" });
      }

      if (
        !inputBooleanFlag(input, "skip-shell-integration") &&
        !inputBooleanFlag(input, "no-interactive") &&
        privilege._tag === "Some" &&
        userDataRoot !== undefined
      ) {
        const shellProfile = yield* installShellProfileIntegration(userDataRoot, privilege.value);
        if (shellProfile.exitCode !== 0) {
          yield* recorder.recordFailure("shell", shellProfile.stderr);
          return yield* Effect.fail(
            new ShellProfileIntegrationError({
              message: "Shell profile integration failed.",
              stderr: shellProfile.stderr,
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
      });

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
    if (isDecoratedContext(ctx))
      return formatSummary(
        buildSetupSummary({ providerId, installDir, fileSyncStatus: status, notes }),
        summaryPaintOptions(ctx),
      );
    const completion = `setup complete: Lando runtime (${providerId})\n${fileSyncStatusLine(status)}\nLANDO_INSTALL_DIR="${installDir}"`;
    return notes.length === 0 ? completion : `${completion}\n${notes.join("\n")}`;
  },
};
