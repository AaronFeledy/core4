import { scanRootOwnership } from "@lando/engine/host/root-ownership";
import { previewApprovals } from "@lando/engine/host-changes/plan";
import { config as writeConfig } from "@lando/engine/operations/config";
import {
  preflightGlobalProviderSwitch,
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
import { RedactionService } from "@lando/redaction/service";
import { mapFailures } from "@lando/sdk/command-result";
import { AppPlacementError } from "@lando/sdk/errors";
import {
  ConfigService,
  type Downloader,
  type FileSystem,
  GlobalAppService,
  InteractionService,
  PathsService,
  PrivilegeService,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";
/**
 * `lando meta:setup` prepares the host provider, CA, router, and shell integration.
 *
 * Provider precedence is flag, environment, configuration, interactive choice, default.
 */
import { Effect, Option } from "effect";
import type * as HttpClient from "effect/http/HttpClient";
import { CliInvocation } from "../../../runtime/invocation-context";
import { resolveSetupNetworkTrust, validateSetupNetworkTrust } from "../../commands/setup-network-trust";

import type { LandoCommandSpec } from "../../spec/command-base";
import { runCaSetupStep } from "./setup-ca-step";
import { SETUP_COMMAND_FLAGS } from "./setup-command-flags";
import { approveSetupHostChanges, planSetupHostChanges, setupCanAsk } from "./setup-host-changes";
import {
  type SetupResult,
  SetupResultSchema,
  inputBooleanFlag,
  inputInstallDir,
  inputNetworkProbe,
  inputProviderFlag,
  sourceInstallDir,
} from "./setup-inputs";
import { makeRunPrivilege } from "./setup-privilege";
import {
  SYSTEM_RUNTIME_PROVIDERS,
  maybeSelectSetupProvider,
  setupProviderPlan,
} from "./setup-provider-selection";
import { runProviderSetupStep } from "./setup-provider-step";
import { renderSetupResult } from "./setup-render";
import { runProxySetupStep, runShellProfileSetupStep, runShellServiceSetupStep } from "./setup-service-steps";
import {
  RootOwnedLandoFilesError,
  SetupStepFailedError,
  makeSetupReadinessRecorder,
  runFileSyncSetupStep,
} from "./setup-steps";

export { SetupResultSchema } from "./setup-inputs";
export { maybeSelectSetupProvider } from "./setup-provider-selection";
export { RootOwnedLandoFilesError, SetupStepFailedError, ShellProfileIntegrationError } from "./setup-steps";

/**
 * Root-owned files under Lando's roots (usually from running lando with sudo) break later writes
 * with generic IO errors. Setup checks first and names the fix; it never repairs them as root.
 */
const refuseRootOwnedLandoFiles = Effect.fnUntraced(function* () {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) return;
  const paths = yield* PathsService;
  const { rootOwned } = yield* scanRootOwnership({ paths, uid, gid });
  if (rootOwned.length === 0) return;
  return yield* Effect.fail(
    new RootOwnedLandoFilesError({
      message: `Lando's files include ${rootOwned.length} owned by root, usually left by running lando with sudo, so setup cannot write them.`,
      paths: rootOwned.map((entry) => entry.path),
      remediation: `Give them back to your user, then rerun \`lando setup\` without sudo (Lando asks for administrator access itself when a step needs it):\n${rootOwned.map((entry) => entry.remediation).join("\n")}`,
    }),
  );
});

// Stages that still decide their host changes when they run, so a dry run cannot list them yet.
const DRY_RUN_NOTICES = [
  "The network trust probe was skipped.",
  "Trusting the local CA in the system store and installing the router's port helper are not previewed yet; setup asks about them when it reaches them.",
];

export const setupSpec: LandoCommandSpec<
  SetupResult,
  unknown,
  | ConfigService
  | GlobalConfigSources
  | PathsService
  | RuntimeProviderRegistry
  | HttpClient.HttpClient
  | Downloader
  | InteractionService
  | FileSystem
> = {
  resultSchema: SetupResultSchema,
  id: "meta:setup",
  onlineAcquisition: true,
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
      captured._tag === "None"
        ? (yield* CliInvocation).env
        : captured.value.sources.env
          ? captured.value.env
          : {},
    );
    const configRaw = globalConfig.defaultProviderId;
    const config = configRaw ?? undefined;

    const resolution = resolveProviderSelection({
      ...(flag === undefined ? {} : { flag }),
      ...(env === undefined ? {} : { env }),
      ...(config === undefined ? {} : { config }),
      capabilityDefault: CAPABILITY_DEFAULT_PROVIDER_ID,
    });

    const userDataRootRaw = globalConfig.userDataRoot;
    const userDataRoot =
      typeof userDataRootRaw === "string" && userDataRootRaw.length > 0 ? userDataRootRaw : undefined;
    // A dry run writes nothing, not even the readiness record.
    const dryRun = inputBooleanFlag(input, "dry-run");
    yield* refuseRootOwnedLandoFiles();
    const redaction = yield* Effect.serviceOption(RedactionService);
    const recorder = makeSetupReadinessRecorder(
      dryRun ? undefined : userDataRoot,
      resolution.providerId,
      redaction._tag === "Some" ? redaction.value : undefined,
      (yield* CliInvocation).env,
    );
    if (!dryRun) {
      yield* recorder.start;
      yield* Effect.addFinalizer(recorder.finish);
    }

    const interactionOption = yield* Effect.serviceOption(InteractionService);
    const interaction = interactionOption._tag === "Some" ? interactionOption.value : undefined;

    const selection = yield* maybeSelectSetupProvider({
      resolution,
      yes: inputBooleanFlag(input, "yes"),
      nonInteractive: dryRun || inputBooleanFlag(input, "no-interactive"),
      skipProvider: inputBooleanFlag(input, "skip-provider"),
      ...(interaction === undefined ? {} : { interaction }),
    });

    const selectedProvider = selection.providerId;
    recorder.setProvider(selectedProvider);
    const persistsSelection =
      !inputBooleanFlag(input, "skip-provider") &&
      (selection.source === "flag" || selection.source === "prompt");
    if (!persistsSelection) {
      const globalApp = yield* Effect.serviceOption(GlobalAppService);
      if (globalApp._tag === "Some") {
        const { root } = yield* globalApp.value.paths;
        yield* ensureAppPlacement({ kind: "global", id: "global", root }, selectedProvider).pipe(
          mapFailures((error) =>
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
    const hostPrivilege = yield* Effect.serviceOption(PrivilegeService);
    const selectedProviderId = String(selectedProvider);

    if (dryRun) {
      // The live trust probe is the one network call setup makes before changing anything.
      const network = yield* resolveSetupNetworkTrust(globalConfig);
      const plan = yield* planSetupHostChanges({
        input,
        provider,
        selectedProviderId,
        network,
        privilege: Option.getOrUndefined(hostPrivilege),
        recorder,
      });
      return {
        dryRun: true,
        providerId: provider.id,
        selectionSource: selection.source,
        elevation: plan.elevation,
        changes: previewApprovals(plan.changes, {
          yes: inputBooleanFlag(input, "yes"),
          optInFlags: plan.optInFlags,
          canAsk: yield* setupCanAsk(input, interaction),
        }),
        notices: DRY_RUN_NOTICES,
      } satisfies SetupResult;
    }

    const privilege =
      hostPrivilege._tag === "Some" ? yield* makeRunPrivilege(hostPrivilege.value) : undefined;
    const privilegeOptions = privilege === undefined ? {} : { privilege };
    const withRunPrivilege = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      privilege === undefined ? effect : Effect.provideService(effect, PrivilegeService, privilege);

    const network = yield* validateSetupNetworkTrust(globalConfig, inputNetworkProbe(input)).pipe(
      Effect.tapError((cause) => recorder.recordFailure("network", cause)),
    );

    const shouldPersistProvider =
      (selection.source === "flag" || selection.source === "prompt") && selectedProvider !== config;
    const checkedSwitch = yield* preflightGlobalProviderSwitch(selectedProvider).pipe(
      Effect.tapError((cause) => recorder.recordFailure("provider", cause)),
    );

    const plan = yield* planSetupHostChanges({
      input,
      provider,
      selectedProviderId,
      network,
      privilege,
      recorder,
    });
    const hostChanges = yield* approveSetupHostChanges({ plan, input, interaction, privilege, recorder });

    yield* runProviderSetupStep({
      input,
      provider,
      selectedProviderId,
      network,
      inspectOptions: plan.inspectOptions,
      hostChanges: hostChanges.applier,
      recorder,
    });

    const providerSwitch = yield* switchGlobalProviderForSetup(selectedProvider, {
      checked: checkedSwitch,
    }).pipe(Effect.tapError((cause) => recorder.recordFailure("provider", cause)));
    if (!inputBooleanFlag(input, "skip-provider") && shouldPersistProvider) {
      yield* writeConfig({ subcommand: "set", key: "defaultProviderId", value: selectedProviderId }).pipe(
        Effect.tapError((cause) => recorder.recordFailure("provider", cause)),
      );
    }
    const trustStores = yield* runCaSetupStep(input, privilegeOptions, recorder, selectedProviderId).pipe(
      withHostProvider,
    );
    yield* runProxySetupStep(input, recorder, selectedProviderId).pipe(withHostProvider, withRunPrivilege);
    yield* runShellServiceSetupStep(input, recorder, selectedProviderId).pipe(withHostProvider);

    if (userDataRoot !== undefined) {
      yield* runShellProfileSetupStep(input, userDataRoot, recorder);
    }

    const fileSyncStatus = yield* runFileSyncSetupStep({
      provider,
      input,
      userDataRoot,
      network,
      recorder,
      ...(globalConfig.defaultFileSyncEngine === undefined
        ? {}
        : { defaultEngine: globalConfig.defaultFileSyncEngine }),
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
      dryRun: false,
      providerId: provider.id,
      installDir: inputInstallDir(input) ?? sourceInstallDir(),
      fileSyncStatus,
      networkCaInjectionConfigured,
      ...(providerSwitch === undefined ? {} : { providerSwitch }),
      ...(trustStores === undefined ? {} : { trustStores }),
      hostChanges: hostChanges.outcomes(),
    } satisfies SetupResult;
  }, Effect.scoped),
  render: renderSetupResult,
};
