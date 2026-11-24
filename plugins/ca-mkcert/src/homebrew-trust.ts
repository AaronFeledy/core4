/**
 * Homebrew's CA bundle. The `ca-certificates` formula writes `<prefix>/etc/ca-certificates/cert.pem`
 * from the system trust store when it installs; Homebrew's OpenSSL, curl, PHP and friends read that
 * file instead of the system store. A bundle built before the local CA was trusted lacks the root,
 * so `brew postinstall ca-certificates` rebuilds it. Homebrew does not exist on Windows.
 */
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { TrustStoreStatus } from "@lando/sdk/schema";
import type { ProcessResult, ProcessRunner } from "@lando/sdk/services";
import { type Context, Effect, Result } from "effect";

import { PEM_BLOCK, pemsContainRoot } from "./host-trust.ts";
import { INSTALL_TRUST_REMEDIATION } from "./system-trust.ts";

const BREW_ENV = { HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ENV_HINTS: "1" } as const;
/** Rebuilding scans the macOS keychains certificate by certificate; a hung brew must not hang setup. */
const BREW_TIMEOUT_MS = 180_000;

export type HostEnv = Readonly<Record<string, string | undefined>>;

interface HomebrewBundle {
  readonly prefix: string;
  readonly path: string;
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

export const locateBundles = async (
  env: HostEnv,
  platform: string,
): Promise<ReadonlyArray<HomebrewBundle>> => {
  if (platform === "win32") return [];
  const bundles: HomebrewBundle[] = [];
  for (const prefix of homebrewPrefixes(env)) {
    if (!(await exists(join(prefix, "opt", "ca-certificates")))) continue;
    bundles.push({ prefix, path: join(prefix, "etc", "ca-certificates", "cert.pem") });
  }
  return bundles;
};

/** A bundle that is missing or unreadable counts as lacking the root: rebuilding it is the repair. */
const bundleHasRoot = (path: string, root: string): Promise<boolean> =>
  readFile(path, "utf8").then(
    (text) => pemsContainRoot(text.match(PEM_BLOCK) ?? [], root),
    () => false,
  );

const row = (
  { path }: HomebrewBundle,
  state: Omit<TrustStoreStatus, "id" | "name" | "location">,
): TrustStoreStatus => ({ id: "homebrew", name: "Homebrew CA bundle", location: path, ...state });

const TRUSTED = { state: "trusted" } as const;

const missing = (detail: string, remediation: string) =>
  ({ state: "untrusted", reason: "missing", detail, remediation }) as const;

const refreshFailed = (detail: string, remediation: string) =>
  ({ state: "untrusted", reason: "refresh-failed", detail, remediation }) as const;

const LACKS_ROOT = "The bundle does not include the local CA.";

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
  const rebuild = Effect.fn("Homebrew.refreshCaBundle")(function* (located: HomebrewBundle, root: string) {
    const ran = yield* processRunner
      .run({
        cmd: join(located.prefix, "bin", "brew"),
        args: ["postinstall", "ca-certificates"],
        env: BREW_ENV,
        timeoutMs: BREW_TIMEOUT_MS,
      })
      .pipe(Effect.result);
    if (Result.isFailure(ran)) {
      return row(
        located,
        refreshFailed(
          `Lando could not run Homebrew: ${ran.failure.message}`,
          `${ran.failure.remediation} Then run \`lando setup\` again.`,
        ),
      );
    }
    const result: ProcessResult = ran.success;
    if (result.exitCode !== 0) {
      return row(
        located,
        refreshFailed(
          `\`brew postinstall ca-certificates\` failed: ${brewFailureDetail(result)}`,
          "Fix the Homebrew error, then run `lando setup` again.",
        ),
      );
    }
    if (yield* Effect.promise(() => bundleHasRoot(located.path, root))) return row(located, TRUSTED);
    return row(
      located,
      missing(
        "Homebrew rebuilt it without the local CA.",
        "Check that the system trust store includes the local CA with `lando doctor`, then run `lando setup` again.",
      ),
    );
  });

  const inspectBundle = (located: HomebrewBundle, root: string) =>
    Effect.promise(() => bundleHasRoot(located.path, root)).pipe(
      Effect.map((has) => row(located, has ? TRUSTED : missing(LACKS_ROOT, INSTALL_TRUST_REMEDIATION))),
    );

  const located = Effect.promise(() => locateBundles(env, platform));

  return {
    /** One row per Homebrew bundle. Reads files only. */
    inspect: (root: string): Effect.Effect<ReadonlyArray<TrustStoreStatus>> =>
      Effect.flatMap(located, (bundles) => Effect.all(bundles.map((bundle) => inspectBundle(bundle, root)))),
    /**
     * Rebuild each bundle that lacks `root`. A bundle rebuilt from a system store that does not trust
     * the root would still lack it, so nothing is rebuilt unless `systemTrusted`. Failures become
     * untrusted rows, never setup failures.
     */
    refresh: Effect.fn("Homebrew.refreshCaBundles")(function* (root: string, systemTrusted: boolean) {
      const rows: TrustStoreStatus[] = [];
      for (const bundle of yield* located) {
        const inspected = yield* inspectBundle(bundle, root);
        rows.push(inspected.state === "trusted" || !systemTrusted ? inspected : yield* rebuild(bundle, root));
      }
      return rows;
    }),
  };
};

export type HomebrewTrust = ReturnType<typeof makeHomebrewTrust>;
