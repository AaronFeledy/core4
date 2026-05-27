/**
 * `lando meta:setup` — provider, CA, proxy, and shell-integration setup.
 *
 * Bootstrap: `provider`.
 * **Interactive only** — not exported as a function from `@lando/core/cli`;
 * embedding hosts construct equivalent flows from `@lando/core/services`
 * and `PrivilegeService`.
 */
import { fileURLToPath } from "node:url";

import { Flags } from "@oclif/core";
import { DateTime, Effect } from "effect";

import { AbsolutePath, AppId, type AppPlan, ProviderId } from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";

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

const inputProviderId = (input: unknown): ProviderId | undefined => {
  if (typeof input !== "object" || input === null || !("flags" in input)) return undefined;
  const flags = input.flags;
  if (typeof flags !== "object" || flags === null || !("provider" in flags)) return undefined;
  const provider = flags.provider;
  return typeof provider === "string" && provider.length > 0 ? ProviderId.make(provider) : undefined;
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
  metadata: {
    resolvedAt: DateTime.unsafeMake("1970-01-01T00:00:00.000Z"),
    source: "meta:setup",
    runtime: 4,
  },
  extensions: {},
});

export const setupSpec: LandoCommandSpec<SetupResult, unknown, RuntimeProviderRegistry> = {
  id: "meta:setup",
  summary: "Run host setup (provider, CA, proxy, shell integration).",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "provider",
  run: (input) =>
    Effect.gen(function* () {
      const registry = yield* RuntimeProviderRegistry;
      const providerId = inputProviderId(input);
      const provider = yield* registry.select(
        providerId === undefined ? undefined : setupProviderPlan(providerId),
      );

      yield* Effect.scoped(provider.setup({ force: false }));

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
    provider: Flags.string({ description: "Choose a provider (e.g. docker, podman)." }),
    "skip-provider": Flags.boolean({ default: false }),
    "skip-proxy": Flags.boolean({ default: false }),
    "skip-install-ca": Flags.boolean({ default: false }),
    "skip-shell-integration": Flags.boolean({ default: false }),
  };
  static override landoSpec: LandoCommandSpec = setupSpec;
  static override bootstrap = setupSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(setupSpec);
  }
}
