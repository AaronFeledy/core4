import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rootEnvKeys = [
  "LANDO_USER_DATA_ROOT",
  "LANDO_USER_CACHE_ROOT",
  "LANDO_USER_CONF_ROOT",
  "LANDO_SYSTEM_PLUGIN_ROOT",
] as const;

let installed = false;
let created: string | undefined;

/**
 * Fills each unset Lando root under one `lando-test-roots-*` tree. Ownership is
 * the returned path only; never remove a path read from env. Mutates `env`.
 */
const allocateIsolatedTestRoots = (env: Record<string, string | undefined>): string | undefined => {
  if (env.LANDO_TEST_USE_REAL_ROOTS === "1") return undefined;
  const unsetKeys = rootEnvKeys.filter((key) => env[key] === undefined);
  if (unsetKeys.length === 0) return undefined;
  const root = mkdtempSync(join(tmpdir(), "lando-test-roots-"));
  for (const key of unsetKeys) env[key] = join(root, key.toLowerCase());
  return root;
};

const releaseIsolatedTestRoots = (directory: string | undefined): void => {
  if (directory === undefined) return;
  try {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (cause) {
    const code =
      cause instanceof Error && "code" in cause && cause.code !== undefined ? String(cause.code) : "unknown";
    process.stderr.write(`failed to remove test roots ${directory} (${code})\n`);
  }
};

type TestEnv = Readonly<Record<string, string | undefined>>;

/**
 * Hands `run` a copy of `env` whose unset roots point into one runner-owned tree, then removes
 * that tree once `run` settles, so `run` must settle only after its test child is reaped. A child
 * that inherits all four keys owns nothing. Live runs get no tree: `runWithLiveTestRoots`
 * allocates its Podman roots only while every key is unset.
 */
export const withRunnerOwnedTestRoots = async <A>(
  options: { readonly env: TestEnv; readonly live: boolean },
  run: (env: TestEnv) => Promise<A>,
): Promise<A> => {
  const env = { ...options.env };
  const directory = options.live ? undefined : allocateIsolatedTestRoots(env);
  try {
    return await run(env);
  } finally {
    releaseIsolatedTestRoots(directory);
  }
};

/** Process preload: allocate once, remove on `exit` (covers `bun -e` / script import). */
export const installProcessTestRoots = (): void => {
  if (installed) return;
  installed = true;
  created = allocateIsolatedTestRoots(process.env);
  if (created !== undefined) {
    process.on("exit", () => {
      releaseIsolatedTestRoots(created);
    });
  }
};

export const releaseCreatedTestRoots = (): void => {
  releaseIsolatedTestRoots(created);
  created = undefined;
};
