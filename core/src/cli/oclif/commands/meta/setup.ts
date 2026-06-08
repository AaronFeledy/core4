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
import { DateTime, Effect } from "effect";

import { makeMutagenDownloader } from "@lando/file-sync-mutagen";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, type AppPlan, ProviderId } from "@lando/sdk/schema";
import {
  CertificateAuthority,
  ConfigService,
  FileSyncEngine,
  ProxyService,
  RuntimeProviderRegistry,
  SshService,
} from "@lando/sdk/services";

import {
  CAPABILITY_DEFAULT_PROVIDER_ID,
  readProviderEnvVar,
  resolveProviderSelection,
} from "../../../../providers/precedence.ts";
import { HostProxyServiceDisabled } from "../../../../subsystems/host-proxy/api.ts";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

type FileSyncStatus = "deferred" | "installed" | "satisfied" | "unavailable";

interface SetupResult {
  readonly providerId: string;
  readonly installDir: string;
  readonly fileSyncStatus: FileSyncStatus;
}

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

export const setupSpec: LandoCommandSpec<SetupResult, unknown, ConfigService | RuntimeProviderRegistry> = {
  id: "meta:setup",
  summary: "Run host setup (provider, CA, proxy, shell integration).",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "minimal",
  run: (input) =>
    Effect.gen(function* () {
      const configService = yield* ConfigService;
      const registry = yield* RuntimeProviderRegistry;

      const flag = inputProviderFlag(input);
      const env = readProviderEnvVar(process.env);
      const configRaw = yield* configService.get("defaultProviderId");
      const config = configRaw ?? undefined;

      const resolution = resolveProviderSelection({
        ...(flag === undefined ? {} : { flag }),
        ...(env === undefined ? {} : { env }),
        ...(config === undefined ? {} : { config }),
        capabilityDefault: CAPABILITY_DEFAULT_PROVIDER_ID,
      });

      const provider = yield* registry.select(setupProviderPlan(resolution.providerId));

      const selectedProviderId = String(resolution.providerId);
      if (!inputBooleanFlag(input, "skip-provider")) {
        if (selectedProviderId in SYSTEM_RUNTIME_PROVIDERS) {
          const available = yield* provider.isAvailable;
          if (!available) return yield* Effect.fail(systemRuntimeUnavailableError(selectedProviderId));
        }
        const runtimeBundleUrl = inputStringFlag(input, "runtime-bundle-url");
        yield* Effect.scoped(
          provider.setup({
            force: false,
            ...(runtimeBundleUrl === undefined ? {} : { runtimeBundleUrl }),
          }),
        );
      }

      const ca = yield* Effect.serviceOption(CertificateAuthority);
      if (ca._tag === "Some") {
        yield* ca.value.setup({
          force: false,
          ...(inputBooleanFlag(input, "skip-install-ca") ? { skipTrustInstall: true } : {}),
        });
      }

      if (!inputBooleanFlag(input, "skip-proxy")) {
        const proxy = yield* Effect.serviceOption(ProxyService);
        if (proxy._tag === "Some") yield* proxy.value.setup();
      }

      if (!inputBooleanFlag(input, "skip-shell-integration")) {
        const ssh = yield* Effect.serviceOption(SshService);
        if (ssh._tag === "Some") yield* ssh.value.setup({ force: false });
      }

      if (shouldDisableHostProxyForSetup(input)) {
        yield* HostProxyServiceDisabled.setup({ mode: "none" });
      }

      const userDataRootRaw = yield* configService.get("userDataRoot");
      const userDataRoot =
        typeof userDataRootRaw === "string" && userDataRootRaw.length > 0 ? userDataRootRaw : undefined;
      let fileSyncStatus: SetupResult["fileSyncStatus"] = "satisfied";

      if (provider.capabilities.bindMountPerformance === "slow" && inputSkipFileSync(input)) {
        fileSyncStatus = "deferred";
        if (userDataRoot !== undefined) yield* recordDeferredFileSyncSetup(userDataRoot);
      } else if (provider.capabilities.bindMountPerformance === "slow") {
        const fileSync = yield* Effect.serviceOption(FileSyncEngine);
        if (fileSync._tag === "Some") {
          yield* Effect.scoped(fileSync.value.setup({ force: false }));
          fileSyncStatus = "installed";
        } else {
          if (userDataRoot !== undefined) {
            const downloader = makeMutagenDownloader();
            yield* downloader.setup({ userDataRoot });
            fileSyncStatus = "installed";
          } else {
            fileSyncStatus = "unavailable";
          }
        }
      }

      return {
        providerId: provider.id,
        installDir: inputInstallDir(input) ?? sourceInstallDir(),
        fileSyncStatus,
      };
    }),
  render: (result) => {
    if (
      typeof result !== "object" ||
      result === null ||
      !("providerId" in result) ||
      !("installDir" in result)
    ) {
      return undefined;
    }
    const status = "fileSyncStatus" in result ? String(result.fileSyncStatus) : "satisfied";
    return `setup complete: Lando runtime (${String(result.providerId)})\n${fileSyncStatusLine(status)}\nLANDO_INSTALL_DIR="${String(result.installDir)}"`;
  },
};

export default class SetupCommand extends LandoCommandBase {
  static override description = "Run provider, CA, proxy, and shell-integration setup.";
  static override aliases = [...resolveTopLevelAliases(setupSpec)];
  static override flags = {
    yes: Flags.boolean({ description: "Skip confirmation prompts.", default: false }),
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
