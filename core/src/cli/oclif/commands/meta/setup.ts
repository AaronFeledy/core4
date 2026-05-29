/**
 * `lando meta:setup` prepares the host provider, CA, proxy, and shell integration.
 *
 * Provider selection uses `flag > Landofile > env > config > capability-default`.
 * This command skips Landofile loading, so the effective inputs are
 * `--provider > LANDO_PROVIDER > config > default`.
 */
import { fileURLToPath } from "node:url";

import { Flags } from "@oclif/core";
import { DateTime, Effect } from "effect";

import { makeMutagenDownloader } from "@lando/file-sync-mutagen";
import { AbsolutePath, AppId, type AppPlan, ProviderId } from "@lando/sdk/schema";
import { ConfigService, RuntimeProviderRegistry } from "@lando/sdk/services";

import {
  CAPABILITY_DEFAULT_PROVIDER_ID,
  readProviderEnvVar,
  resolveProviderSelection,
} from "../../../../providers/precedence.ts";
import { HostProxyServiceDisabled } from "../../../../subsystems/host-proxy/api.ts";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

interface SetupResult {
  readonly providerId: string;
  readonly installDir: string;
}

const sourceInstallDir = (): string =>
  fileURLToPath(new URL("../../../../../", import.meta.url)).replace(/[\\/]$/u, "");

const inputInstallDir = (input: unknown): string | undefined => {
  if (typeof input !== "object" || input === null || !("installDir" in input)) return undefined;
  const installDir = input.installDir;
  return typeof installDir === "string" ? installDir : undefined;
};

const inputProviderFlag = (input: unknown): ProviderId | undefined => {
  if (typeof input !== "object" || input === null || !("flags" in input)) return undefined;
  const flags = (input as { flags?: unknown }).flags;
  if (typeof flags !== "object" || flags === null || !("provider" in flags)) return undefined;
  const provider = (flags as { provider?: unknown }).provider;
  return typeof provider === "string" && provider.length > 0 ? ProviderId.make(provider) : undefined;
};

const inputSkipFileSync = (input: unknown): boolean => {
  if (typeof input !== "object" || input === null || !("flags" in input)) return false;
  const flags = (input as { flags?: unknown }).flags;
  if (typeof flags !== "object" || flags === null) return false;
  return (flags as Record<string, unknown>)["skip-file-sync"] === true;
};

const inputHostProxyMode = (input: unknown): "auto" | "none" => {
  if (typeof input !== "object" || input === null || !("flags" in input)) return "auto";
  const flags = (input as { flags?: unknown }).flags;
  if (typeof flags !== "object" || flags === null) return "auto";
  return (flags as Record<string, unknown>)["host-proxy"] === "none" ? "none" : "auto";
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

export const setupSpec: LandoCommandSpec<SetupResult, unknown, ConfigService | RuntimeProviderRegistry> = {
  id: "meta:setup",
  summary: "Run host setup (provider, CA, proxy, shell integration).",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "provider",
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

      yield* Effect.scoped(provider.setup({ force: false }));

      if (inputHostProxyMode(input) === "none") {
        yield* HostProxyServiceDisabled.setup({ mode: "none" });
      }

      if (provider.capabilities.bindMountPerformance === "slow" && !inputSkipFileSync(input)) {
        const userDataRootRaw = yield* configService.get("userDataRoot");
        if (typeof userDataRootRaw === "string" && userDataRootRaw.length > 0) {
          const downloader = makeMutagenDownloader();
          yield* downloader.setup({ userDataRoot: userDataRootRaw });
        }
      }

      return { providerId: provider.id, installDir: inputInstallDir(input) ?? sourceInstallDir() };
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
    return `setup complete: Lando runtime (${String(result.providerId)})\nLANDO_INSTALL_DIR="${String(result.installDir)}"`;
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
