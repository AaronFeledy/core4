/**
 * Homebrew's CA bundle. The `ca-certificates` formula writes `<prefix>/etc/ca-certificates/cert.pem`
 * from the system trust store when it installs; Homebrew's OpenSSL, curl, PHP and friends read that
 * file instead of the system store. A bundle built before the local CA was trusted lacks the root,
 * so `brew postinstall ca-certificates` rebuilds it. Homebrew does not exist on Windows.
 */
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { CommandWarning } from "@lando/sdk/schema";
import type { CaSetupResult, CaTrustBundle, ProcessResult, ProcessRunner } from "@lando/sdk/services";
import { type Context, Effect, Result } from "effect";

import { pemsContainRoot } from "./host-trust.ts";

const OWNER = "Homebrew";
const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
const BREW_ENV = { HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ENV_HINTS: "1" } as const;
/** Rebuilding scans the macOS keychains certificate by certificate; a hung brew must not hang setup. */
const BREW_TIMEOUT_MS = 180_000;

export type HostEnv = Readonly<Record<string, string | undefined>>;

interface HomebrewBundle {
  readonly prefix: string;
  readonly bundle: CaTrustBundle;
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

/** `HOMEBREW_PREFIX`, then the prefix of the `brew` on PATH. The brew path is not resolved: on Linux it links into the repository, not the prefix. */
const homebrewPrefixes = (env: HostEnv): ReadonlyArray<string> => {
  const brew = Bun.which("brew", { PATH: env.PATH ?? "" });
  const candidates = [env.HOMEBREW_PREFIX, brew === null ? undefined : dirname(dirname(brew))];
  return [
    ...new Set(candidates.flatMap((prefix) => (prefix !== undefined && isAbsolute(prefix) ? [prefix] : []))),
  ];
};

const locateBundles = async (env: HostEnv, platform: string): Promise<ReadonlyArray<HomebrewBundle>> => {
  if (platform === "win32") return [];
  const bundles: HomebrewBundle[] = [];
  for (const prefix of homebrewPrefixes(env)) {
    if (!(await exists(join(prefix, "opt", "ca-certificates")))) continue;
    bundles.push({
      prefix,
      bundle: { owner: OWNER, path: join(prefix, "etc", "ca-certificates", "cert.pem") },
    });
  }
  return bundles;
};

/** A bundle that is missing or unreadable counts as lacking the root: rebuilding it is the repair. */
const bundleHasRoot = (path: string, root: string): Promise<boolean> =>
  readFile(path, "utf8").then(
    (text) => pemsContainRoot(text.match(PEM_BLOCK) ?? [], root),
    () => false,
  );

const staleBundles = async (root: string, env: HostEnv, platform: string) => {
  const stale: HomebrewBundle[] = [];
  for (const located of await locateBundles(env, platform)) {
    if (!(await bundleHasRoot(located.bundle.path, root))) stale.push(located);
  }
  return stale;
};

const staleWarning = (bundle: CaTrustBundle, reason: string, remediation: string): CommandWarning => ({
  code: "CA_BUNDLE_STALE",
  message: `${bundle.owner}'s CA bundle at ${bundle.path} does not include the local CA: ${reason}.`,
  remediation,
  context: { bundle: bundle.path, owner: bundle.owner },
});

const RETRY = "then run `lando setup` again.";

/**
 * Homebrew prints the post-install error on stdout and only a summary on stderr, around its own
 * progress heading and a hint to rerun the step by hand, which Lando does for the user instead.
 */
const brewFailureDetail = (result: ProcessResult): string => {
  const lines = `${result.stdout}\n${result.stderr}`
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !line.startsWith("==>") &&
        line !== "You can try again using:" &&
        !line.startsWith("brew postinstall"),
    );
  return lines.length === 0 ? `exit code ${result.exitCode}` : lines.join("; ");
};

export interface HomebrewTrustOptions {
  readonly processRunner: Context.Service.Shape<typeof ProcessRunner>;
  readonly env: HostEnv;
  readonly platform: string;
}

export const makeHomebrewTrust = ({ processRunner, env, platform }: HomebrewTrustOptions) => {
  const refreshBundle = Effect.fn("Homebrew.refreshCaBundle")(function* (
    located: HomebrewBundle,
    root: string,
  ) {
    const { bundle } = located;
    const ran = yield* processRunner
      .run({
        cmd: join(located.prefix, "bin", "brew"),
        args: ["postinstall", "ca-certificates"],
        env: BREW_ENV,
        timeoutMs: BREW_TIMEOUT_MS,
      })
      .pipe(Effect.result);
    if (Result.isFailure(ran)) {
      return staleWarning(
        bundle,
        `Lando could not run Homebrew: ${ran.failure.message}`,
        `${ran.failure.remediation} Then run \`lando setup\` again.`,
      );
    }
    const result: ProcessResult = ran.success;
    if (result.exitCode !== 0) {
      return staleWarning(
        bundle,
        `\`brew postinstall ca-certificates\` failed: ${brewFailureDetail(result)}`,
        `Fix the Homebrew error, ${RETRY}`,
      );
    }
    if (yield* Effect.promise(() => bundleHasRoot(bundle.path, root))) return undefined;
    return staleWarning(
      bundle,
      "Homebrew rebuilt it without the local CA",
      `Check that the system trust store includes the local CA with \`lando doctor\`, ${RETRY}`,
    );
  });

  return {
    /** Bundles that lack `root`. Reads files only. */
    staleBundles: (root: string): Effect.Effect<ReadonlyArray<CaTrustBundle>> =>
      Effect.promise(() => staleBundles(root, env, platform)).pipe(
        Effect.map((stale) => stale.map(({ bundle }) => bundle)),
      ),
    /** Rebuild each bundle that lacks `root`; failures become warnings, never setup failures. */
    refresh: Effect.fn("Homebrew.refreshCaBundles")(function* (root: string) {
      const refreshedBundles: CaTrustBundle[] = [];
      const warnings: CommandWarning[] = [];
      for (const located of yield* Effect.promise(() => staleBundles(root, env, platform))) {
        const warning = yield* refreshBundle(located, root);
        if (warning === undefined) refreshedBundles.push(located.bundle);
        else warnings.push(warning);
      }
      return { refreshedBundles, warnings } satisfies CaSetupResult;
    }),
  };
};

export type HomebrewTrust = ReturnType<typeof makeHomebrewTrust>;
