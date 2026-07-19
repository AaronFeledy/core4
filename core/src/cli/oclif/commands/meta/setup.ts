/**
 * `lando meta:setup` prepares the host provider, CA, proxy, and shell integration.
 *
 * Provider selection uses `flag > Landofile > env > config > capability-default`.
 * This command skips Landofile loading, so the effective inputs are
 * `--provider > LANDO_PROVIDER > config > default`.
 */
import { Effect } from "effect";

import {
  ConfigService,
  type Downloader,
  type HttpClient,
  PrivilegeService,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import { NetworkTrust } from "../../../../http-client/network-trust.ts";
import {
  CAPABILITY_DEFAULT_PROVIDER_ID,
  readProviderEnvVar,
  resolveProviderSelection,
} from "../../../../providers/precedence.ts";
import { HostProxyServiceDisabled } from "../../../../subsystems/host-proxy/api.ts";
import {
  networkTrustFromResolved,
  validateSetupNetworkTrust,
} from "../../../commands/setup-network-trust.ts";
import { installShellProfileIntegration } from "../../../commands/shellenv.ts";
import { isDecoratedContext } from "../../../renderer-boundary.ts";
import { formatSummary } from "../../../renderer/summary.ts";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";
import {
  SETUP_BUILTIN_FLAGS,
  SETUP_PLUGIN_FLAGS,
  contributedSetupFlagsForProvider,
} from "./setup-command-flags.ts";
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
} from "./setup-inputs.ts";
import {
  SYSTEM_RUNTIME_PROVIDERS,
  maybeSelectSetupProvider,
  setupProviderPlan,
  systemRuntimeUnavailableError,
} from "./setup-provider-selection.ts";
import { runCaSetupStep, runProxySetupStep, runShellServiceSetupStep } from "./setup-service-steps.ts";
import {
  ShellProfileIntegrationError,
  makeSetupReadinessRecorder,
  runFileSyncSetupStep,
  runtimeServiceReadinessFor,
} from "./setup-steps.ts";
import { buildSetupSummary, fileSyncStatusLine } from "./setup-summary.ts";

export { SetupResultSchema, shouldDisableHostProxyForSetup } from "./setup-inputs.ts";
export { maybeSelectSetupProvider } from "./setup-provider-selection.ts";
export { ShellProfileIntegrationError, setupDeferredFileSyncPath } from "./setup-steps.ts";

export const setupSpec: LandoCommandSpec<
  SetupResult,
  unknown,
  ConfigService | RuntimeProviderRegistry | HttpClient | Downloader
> = {
  resultSchema: SetupResultSchema,
  id: "meta:setup",
  summary: "Run host setup (provider, CA, proxy, shell integration).",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "provider",
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
        ...(config === undefined ? {} : { config }),
        capabilityDefault: CAPABILITY_DEFAULT_PROVIDER_ID,
      });

      const selectedProvider = yield* Effect.promise(() =>
        maybeSelectSetupProvider({
          resolution,
          yes: inputBooleanFlag(input, "yes"),
          nonInteractive: inputBooleanFlag(input, "no-interactive"),
          skipProvider: inputBooleanFlag(input, "skip-provider"),
        }),
      );

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
        yield* Effect.scoped(
          provider.setup({
            force: false,
            network,
            ...privilegeOptions,
            ...(runtimeBundleUrl === undefined ? {} : { runtimeBundleUrl }),
            ...(runtimeBundleSha256 === undefined ? {} : { runtimeBundleSha256 }),
            ...(Object.keys(setupFlags).length === 0 ? {} : { setupFlags }),
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

      yield* runCaSetupStep(input, privilegeOptions, recorder);
      yield* runProxySetupStep(input, recorder);
      yield* runShellServiceSetupStep(input, recorder);

      if (shouldDisableHostProxyForSetup(input)) {
        yield* HostProxyServiceDisabled.setup({ mode: "none" });
      }

      if (
        !inputBooleanFlag(input, "skip-shell-integration") &&
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

      return {
        providerId: provider.id,
        installDir: inputInstallDir(input) ?? sourceInstallDir(),
        fileSyncStatus,
      };
    }),
  render: (result, _input, ctx) => {
    if (
      typeof result !== "object" ||
      result === null ||
      !("providerId" in result) ||
      !("installDir" in result)
    ) {
      return undefined;
    }
    const status = "fileSyncStatus" in result ? String(result.fileSyncStatus) : "satisfied";
    const providerId = String(result.providerId);
    const installDir = String(result.installDir);
    if (isDecoratedContext(ctx))
      return formatSummary(buildSetupSummary(providerId, installDir, status), { columns: ctx?.columns });
    return `setup complete: Lando runtime (${providerId})\n${fileSyncStatusLine(status)}\nLANDO_INSTALL_DIR="${installDir}"`;
  },
};

export default class SetupCommand extends LandoCommandBase {
  static override description = "Run provider, CA, proxy, and shell-integration setup.";
  static override aliases = [...resolveTopLevelAliases(setupSpec)];
  static override flags = {
    ...SETUP_BUILTIN_FLAGS,
    ...SETUP_PLUGIN_FLAGS.flags,
  };
  static override landoSpec: LandoCommandSpec = setupSpec;
  static override bootstrap = setupSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(setupSpec);
  }
}
