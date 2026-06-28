/**
 * `lando meta:setup` prepares the host provider, CA, proxy, and shell integration.
 *
 * Provider selection uses `flag > Landofile > env > config > capability-default`.
 * This command skips Landofile loading, so the effective inputs are
 * `--provider > LANDO_PROVIDER > config > default`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Flags } from "@oclif/core";
import { Data, DateTime, Effect } from "effect";

import { makeMutagenDownloader } from "@lando/file-sync-mutagen";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, type AppPlan, ProviderId } from "@lando/sdk/schema";
import {
  CertificateAuthority,
  ConfigService,
  FileSyncEngine,
  PrivilegeService,
  ProxyService,
  RuntimeProviderRegistry,
  SshService,
} from "@lando/sdk/services";

import { NetworkTrust } from "../../../../http-client/network-trust.ts";
import {
  type InteractionPrompter,
  makePromiseInteractionPrompter,
} from "../../../../interaction/prompter.ts";
import { makeInteractionService } from "../../../../interaction/service.ts";
import {
  CAPABILITY_DEFAULT_PROVIDER_ID,
  type ProviderSelectionResolution,
  readProviderEnvVar,
  resolveProviderSelection,
} from "../../../../providers/precedence.ts";
import { HostProxyServiceDisabled } from "../../../../subsystems/host-proxy/api.ts";
import {
  type SetupNetworkTrustFetch,
  type SetupNetworkTrustProbe,
  makeSetupNetworkTrustProbe,
  networkTrustFromResolved,
  validateSetupNetworkTrust,
} from "../../../commands/setup-network-trust.ts";
import {
  type SetupReadinessRuntimeService,
  type SetupReadinessStep,
  setupFailureEvidence,
  setupFailureRemediation,
  writeSetupReadiness,
} from "../../../commands/setup-readiness.ts";
import { installShellProfileIntegration } from "../../../commands/shellenv.ts";
import { isDecoratedContext } from "../../../renderer-boundary.ts";
import { type SummaryDocument, type SummaryTone, formatSummary } from "../../../renderer/summary.ts";

import {
  EmptyResultSchema,
  LandoCommandBase,
  type LandoCommandSpec,
  resolveTopLevelAliases,
} from "../../command-base.ts";

type FileSyncStatus = "deferred" | "installed" | "satisfied" | "unavailable";

interface SetupResult {
  readonly providerId: string;
  readonly installDir: string;
  readonly fileSyncStatus: FileSyncStatus;
}

interface RuntimeServiceStatusForReadiness {
  readonly running: boolean;
  readonly socketPath?: string;
  readonly pid?: number;
}

interface RuntimeServiceReadinessProvider {
  readonly getRuntimeServiceStatus?: Effect.Effect<RuntimeServiceStatusForReadiness, unknown>;
}

const runtimeServiceReadinessFor = (provider: {
  readonly getVersions: Effect.Effect<{ readonly runtime?: string }, unknown>;
}): Effect.Effect<SetupReadinessRuntimeService | undefined, never> => {
  const statusEffect = (provider as RuntimeServiceReadinessProvider).getRuntimeServiceStatus;
  if (statusEffect === undefined) return Effect.succeed(undefined);

  return Effect.gen(function* () {
    const status = yield* statusEffect;
    if (status.socketPath === undefined || status.socketPath.length === 0) return undefined;

    const versions = yield* provider.getVersions.pipe(Effect.catchAllCause(() => Effect.succeed(undefined)));
    return {
      running: status.running,
      socketPath: status.socketPath,
      ...(status.pid === undefined ? {} : { pid: status.pid }),
      ...(versions?.runtime === undefined ? {} : { runtimeVersion: versions.runtime }),
    };
  }).pipe(Effect.catchAllCause(() => Effect.succeed(undefined)));
};

export class ShellProfileIntegrationError extends Data.TaggedError("ShellProfileIntegrationError")<{
  readonly message: string;
  readonly stderr: string;
}> {}

export const setupDeferredFileSyncPath = (userDataRoot: string): string =>
  join(userDataRoot, "setup", "file-sync-deferred.json");

const recordDeferredFileSyncSetup = (userDataRoot: string): Effect.Effect<void, never> =>
  Effect.promise(async () => {
    const markerPath = setupDeferredFileSyncPath(userDataRoot);
    await mkdir(join(userDataRoot, "setup"), { recursive: true });
    await writeFile(
      markerPath,
      `${JSON.stringify({ status: "deferred", engineId: "mutagen", resumeCommand: "lando start" })}\n`,
      "utf-8",
    );
  }).pipe(Effect.catchAll(() => Effect.void));

const sourceInstallDir = (): string =>
  fileURLToPath(new URL("../../../../../", import.meta.url)).replace(/[\\/]$/u, "");

const inputInstallDir = (input: unknown): string | undefined => {
  if (typeof input !== "object" || input === null || !("installDir" in input)) return undefined;
  const installDir = input.installDir;
  return typeof installDir === "string" ? installDir : undefined;
};

const inputFlags = (input: unknown): Record<string, unknown> | undefined => {
  if (typeof input !== "object" || input === null || !("flags" in input)) return undefined;
  const flags = (input as { flags?: unknown }).flags;
  return typeof flags === "object" && flags !== null ? (flags as Record<string, unknown>) : undefined;
};

const inputProviderFlag = (input: unknown): ProviderId | undefined => {
  const provider = inputFlags(input)?.provider;
  return typeof provider === "string" && provider.length > 0 ? ProviderId.make(provider) : undefined;
};

const inputSkipFileSync = (input: unknown): boolean => inputFlags(input)?.["skip-file-sync"] === true;

const inputStringFlag = (input: unknown, name: string): string | undefined => {
  const value = inputFlags(input)?.[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const inputBooleanFlag = (input: unknown, name: string): boolean => inputFlags(input)?.[name] === true;

const inputHostProxyMode = (input: unknown): "auto" | "none" =>
  inputFlags(input)?.["host-proxy"] === "none" ? "none" : "auto";

const inputNetworkProbe = (input: unknown): SetupNetworkTrustProbe | undefined => {
  if (typeof input !== "object" || input === null || !("_networkProbe" in input)) return undefined;
  const probe = input._networkProbe;
  return typeof probe === "function" ? (probe as SetupNetworkTrustProbe) : undefined;
};

const inputNetworkFetch = (input: unknown): SetupNetworkTrustFetch | undefined => {
  if (typeof input !== "object" || input === null || !("_networkFetch" in input)) return undefined;
  const fetchImpl = input._networkFetch;
  return typeof fetchImpl === "function" ? (fetchImpl as SetupNetworkTrustFetch) : undefined;
};

export const shouldDisableHostProxyForSetup = (input: unknown): boolean =>
  inputHostProxyMode(input) === "none";

const SYSTEM_RUNTIME_PROVIDERS: Record<string, string> = {
  docker: "Docker",
  podman: "Podman",
};

const systemRuntimeUnavailableError = (providerId: string): ProviderUnavailableError => {
  const runtimeName = SYSTEM_RUNTIME_PROVIDERS[providerId] ?? providerId;
  return new ProviderUnavailableError({
    providerId,
    operation: "setup",
    message: `\`lando setup --provider=${providerId}\` requires an existing ${runtimeName} installation, but ${runtimeName} was not detected on this host.`,
    remediation: `Install ${runtimeName} and make sure it is running, then rerun \`lando setup --provider=${providerId}\`. To use the bundled Lando-managed runtime instead, run \`lando setup\` (the default) or \`lando setup --provider=lando\`.`,
  });
};

const setupProviderPlan = (provider: ProviderId): AppPlan => ({
  id: AppId.make("setup"),
  name: "setup",
  slug: "setup",
  root: AbsolutePath.make("/"),
  provider,
  services: {},
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: {
    resolvedAt: DateTime.unsafeMake("1970-01-01T00:00:00.000Z"),
    source: "meta:setup",
    runtime: 4,
  },
  extensions: {},
});

const SETUP_PROVIDER_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "lando", label: "Lando-managed runtime (bundled, recommended)" },
  { value: "docker", label: "Docker (existing installation required)" },
  { value: "podman", label: "Podman (existing installation required)" },
];

export const maybeSelectSetupProvider = async (params: {
  readonly resolution: ProviderSelectionResolution;
  readonly yes: boolean;
  readonly nonInteractive: boolean;
  readonly skipProvider: boolean;
  readonly interaction?: InteractionPrompter;
}): Promise<ProviderId> => {
  const fallback = params.resolution.providerId;
  if (params.resolution.source !== "default") return fallback;
  if (params.yes || params.nonInteractive || params.skipProvider) return fallback;
  const interaction = params.interaction ?? makePromiseInteractionPrompter(makeInteractionService());
  try {
    const chosen = await interaction.select({
      message: "Select the container runtime provider for Lando",
      name: "provider",
      default: String(fallback),
      choices: SETUP_PROVIDER_CHOICES,
      yes: params.yes,
      ...(params.nonInteractive ? { interactive: false } : {}),
    });
    return chosen === "" ? fallback : ProviderId.make(chosen);
  } catch {
    return fallback;
  }
};

const fileSyncStatusLine = (status: string): string => {
  switch (status) {
    case "deferred":
      return "file-sync: deferred until first accelerated app:start";
    case "installed":
      return "file-sync: installed";
    case "unavailable":
      return "file-sync: unavailable (userDataRoot is not configured)";
    default:
      return "file-sync: already satisfied (native bind mounts)";
  }
};

const fileSyncTone = (status: string): SummaryTone => {
  switch (status) {
    case "deferred":
      return "pending";
    case "unavailable":
      return "warn";
    default:
      return "ok";
  }
};

const buildSetupSummary = (providerId: string, installDir: string, status: string): SummaryDocument => ({
  title: "SETUP",
  subtitle: "complete",
  tone: status === "unavailable" ? "warn" : "ok",
  sections: [
    {
      title: "runtime",
      rows: [
        { label: "provider", tone: "ok", value: providerId },
        { label: "file-sync", tone: fileSyncTone(status), value: status, detail: fileSyncStatusLine(status) },
        { label: "install dir", tone: "info", fields: [{ label: "LANDO_INSTALL_DIR", value: installDir }] },
      ],
    },
  ],
  footer: `Lando runtime ready (${providerId})`,
});

export const setupSpec: LandoCommandSpec<SetupResult, unknown, ConfigService | RuntimeProviderRegistry> = {
  resultSchema: EmptyResultSchema,
  id: "meta:setup",
  summary: "Run host setup (provider, CA, proxy, shell integration).",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "minimal",
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
      const networkProbe = inputNetworkProbe(input) ?? makeSetupNetworkTrustProbe(inputNetworkFetch(input));
      const privilege = yield* Effect.serviceOption(PrivilegeService);
      const privilegeOptions = privilege._tag === "Some" ? { privilege: privilege.value } : {};

      const selectedProviderId = String(selectedProvider);
      const userDataRootRaw = globalConfig.userDataRoot;
      const userDataRoot =
        typeof userDataRootRaw === "string" && userDataRootRaw.length > 0 ? userDataRootRaw : undefined;
      const readinessSteps: SetupReadinessStep[] = [];
      let runtimeServiceReadiness: SetupReadinessRuntimeService | null | undefined;
      const recordReadiness = (step: SetupReadinessStep): Effect.Effect<void, never> => {
        const existingIndex = readinessSteps.findIndex((candidate) => candidate.id === step.id);
        if (existingIndex === -1) readinessSteps.push(step);
        else readinessSteps[existingIndex] = step;
        return writeSetupReadiness(userDataRoot, selectedProviderId, readinessSteps, runtimeServiceReadiness);
      };
      const recordFailure = (id: string, cause: unknown): Effect.Effect<void, never> =>
        recordReadiness({
          id,
          status: "failed",
          evidence: setupFailureEvidence(id, cause),
          remediation: setupFailureRemediation(id, cause),
        });
      const recordUnavailable = (id: string, serviceName: string): Effect.Effect<void, never> => {
        const message = `${serviceName} setup service is not available.`;
        return recordReadiness({
          id,
          status: "unavailable",
          evidence: message,
          remediation: setupFailureRemediation(id, message),
        });
      };
      const network = yield* validateSetupNetworkTrust(globalConfig, networkProbe).pipe(
        Effect.tapError((cause) => recordFailure("network", cause)),
      );
      if (!inputBooleanFlag(input, "skip-provider")) {
        if (selectedProviderId in SYSTEM_RUNTIME_PROVIDERS) {
          const available = yield* provider.isAvailable;
          if (!available) {
            const error = systemRuntimeUnavailableError(selectedProviderId);
            yield* recordFailure("provider", error);
            return yield* Effect.fail(error);
          }
        }
        const runtimeBundleUrl = inputStringFlag(input, "runtime-bundle-url");
        const runtimeBundleSha256 = inputStringFlag(input, "runtime-bundle-sha256");
        yield* Effect.scoped(
          provider.setup({
            force: false,
            network,
            ...privilegeOptions,
            ...(runtimeBundleUrl === undefined ? {} : { runtimeBundleUrl }),
            ...(runtimeBundleSha256 === undefined ? {} : { runtimeBundleSha256 }),
          }),
        ).pipe(
          Effect.provideService(NetworkTrust, networkTrustFromResolved(network)),
          Effect.tapError((cause) => recordFailure("provider", cause)),
        );
        runtimeServiceReadiness = yield* runtimeServiceReadinessFor(provider);
        yield* recordReadiness({
          id: "provider",
          status: "satisfied",
          evidence: `Provider ${selectedProviderId} setup completed.`,
        });
      } else {
        yield* recordReadiness({
          id: "provider",
          status: "skipped",
          evidence: `Provider ${selectedProviderId} setup skipped by --skip-provider.`,
        });
      }

      const ca = yield* Effect.serviceOption(CertificateAuthority);
      if (ca._tag === "Some") {
        yield* ca.value
          .setup({
            force: false,
            ...privilegeOptions,
            ...(inputBooleanFlag(input, "skip-install-ca") ? { skipTrustInstall: true } : {}),
          })
          .pipe(Effect.tapError((cause) => recordFailure("ca", cause)));
        yield* recordReadiness({
          id: "ca",
          status: inputBooleanFlag(input, "skip-install-ca") ? "skipped" : "satisfied",
          evidence: inputBooleanFlag(input, "skip-install-ca")
            ? "Certificate authority trust installation skipped by --skip-install-ca."
            : "Certificate authority setup completed.",
        });
      } else if (inputBooleanFlag(input, "skip-install-ca")) {
        yield* recordReadiness({
          id: "ca",
          status: "skipped",
          evidence: "Certificate authority trust installation skipped by --skip-install-ca.",
        });
      } else {
        yield* recordUnavailable("ca", "Certificate authority");
      }

      if (!inputBooleanFlag(input, "skip-proxy")) {
        const proxy = yield* Effect.serviceOption(ProxyService);
        if (proxy._tag === "Some") {
          yield* proxy.value.setup().pipe(Effect.tapError((cause) => recordFailure("proxy", cause)));
          yield* recordReadiness({ id: "proxy", status: "satisfied", evidence: "Proxy setup completed." });
        } else {
          yield* recordUnavailable("proxy", "Proxy");
        }
      } else {
        yield* recordReadiness({
          id: "proxy",
          status: "skipped",
          evidence: "Proxy setup skipped by --skip-proxy.",
        });
      }

      if (!inputBooleanFlag(input, "skip-shell-integration")) {
        const ssh = yield* Effect.serviceOption(SshService);
        if (ssh._tag === "Some") {
          yield* ssh.value
            .setup({ force: false })
            .pipe(Effect.tapError((cause) => recordFailure("shell", cause)));
          yield* recordReadiness({
            id: "shell",
            status: "satisfied",
            evidence: "Shell integration setup completed.",
          });
        } else {
          yield* recordUnavailable("shell", "Shell integration");
        }
      } else {
        yield* recordReadiness({
          id: "shell",
          status: "skipped",
          evidence: "Shell integration skipped by --skip-shell-integration.",
        });
      }

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
          yield* recordFailure("shell", shellProfile.stderr);
          return yield* Effect.fail(
            new ShellProfileIntegrationError({
              message: "Shell profile integration failed.",
              stderr: shellProfile.stderr,
            }),
          );
        }
      }

      let fileSyncStatus: SetupResult["fileSyncStatus"] = "satisfied";

      if (provider.capabilities.bindMountPerformance === "slow" && inputSkipFileSync(input)) {
        fileSyncStatus = "deferred";
        if (userDataRoot !== undefined) yield* recordDeferredFileSyncSetup(userDataRoot);
        yield* recordReadiness({
          id: "file-sync",
          status: "deferred",
          evidence: "File-sync setup deferred until first accelerated app:start.",
          remediation: "Run `lando start` to finish deferred file-sync setup for accelerated mounts.",
        });
      } else if (provider.capabilities.bindMountPerformance === "slow") {
        const fileSync = yield* Effect.serviceOption(FileSyncEngine);
        if (fileSync._tag === "Some") {
          yield* Effect.scoped(fileSync.value.setup({ force: false, network })).pipe(
            Effect.tapError((cause) => recordFailure("file-sync", cause)),
          );
          fileSyncStatus = "installed";
          yield* recordReadiness({
            id: "file-sync",
            status: "installed",
            evidence: "File-sync setup installed Mutagen acceleration.",
          });
        } else {
          if (userDataRoot !== undefined) {
            const downloader = makeMutagenDownloader();
            yield* downloader
              .setup({ userDataRoot, network })
              .pipe(Effect.tapError((cause) => recordFailure("file-sync", cause)));
            fileSyncStatus = "installed";
            yield* recordReadiness({
              id: "file-sync",
              status: "installed",
              evidence: "File-sync setup downloaded Mutagen acceleration.",
            });
          } else {
            fileSyncStatus = "unavailable";
            yield* recordReadiness({
              id: "file-sync",
              status: "unavailable",
              evidence: "File-sync setup could not run because userDataRoot is not configured.",
              remediation: "Configure userDataRoot and rerun `lando setup`.",
            });
          }
        }
      } else {
        yield* recordReadiness({
          id: "file-sync",
          status: "satisfied",
          evidence: "Native bind mounts satisfy file-sync setup.",
        });
      }

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
    yes: Flags.boolean({ description: "Skip confirmation prompts.", default: false }),
    "no-interactive": Flags.boolean({
      description: "Do not prompt; fail or use documented non-interactive setup defaults.",
      default: false,
    }),
    provider: Flags.string({
      description:
        "Choose a provider (e.g. lando, docker, podman). Overrides Landofile/env/config selection.",
    }),
    "skip-provider": Flags.boolean({ default: false }),
    "skip-proxy": Flags.boolean({ default: false }),
    "skip-install-ca": Flags.boolean({ default: false }),
    "skip-shell-integration": Flags.boolean({ default: false }),
    "skip-file-sync": Flags.boolean({
      description: "Skip Mutagen binary download; deferred to first accelerated app:start.",
      default: false,
    }),
    "runtime-bundle-url": Flags.string({
      description: "Override the Lando-managed runtime bundle URL for setup.",
    }),
    "runtime-bundle-sha256": Flags.string({
      description: "Pinned SHA-256 paired with --runtime-bundle-url for verifying a local bundle.",
    }),
    "host-proxy": Flags.string({
      description:
        "Configure the host-proxy DNS mechanism. `auto` (default) selects the per-platform default; `none` opts out for users managing their own DNS.",
      options: ["auto", "none"],
      default: "auto",
    }),
  };
  static override landoSpec: LandoCommandSpec = setupSpec;
  static override bootstrap = setupSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(setupSpec);
  }
}
