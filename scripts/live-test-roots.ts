import { constants } from "node:fs";
import { access, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type RetirementResult,
  TEMP_PODMAN_ROOT_SETUP_ARGS,
  TEST_ROOT_ENV_KEYS,
  type TempRootRetirement,
  retireTempRoots,
  tempPodmanRootEnv,
} from "@lando/engine/testing/temp-root-retirement";
import { causeMessage } from "@lando/sdk/errors";

type Env = TempRootRetirement["env"];
type RunnerSignal = "SIGINT" | "SIGTERM";
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const satisfies Record<RunnerSignal, number>;
type TestChild = Pick<Bun.Subprocess, "kill" | "exited" | "exitCode" | "signalCode">;
export type TrackTestChild = (child: TestChild) => void;
type LiveTestBinaryReason = "missing" | "directory" | "not-executable";

const LIVE_TEST_BINARY_COPY = {
  missing: {
    subject: (path: string) => `Live test CLI not found at ${path}.`,
    override: " LANDO_SCENARIO_E2E_BINARY points at a missing file.",
  },
  directory: {
    subject: (path: string) => `Live test CLI path ${path} is a directory.`,
    override: " LANDO_SCENARIO_E2E_BINARY points at a directory.",
  },
  "not-executable": {
    subject: (path: string) => `Live test CLI at ${path} is not executable.`,
    override: " LANDO_SCENARIO_E2E_BINARY points at a non-executable file.",
  },
} as const satisfies Record<
  LiveTestBinaryReason,
  { readonly subject: (path: string) => string; readonly override: string }
>;

export class MissingLiveTestBinaryError extends Error {
  readonly path: string;
  readonly reason: LiveTestBinaryReason;
  constructor(path: string, reason: LiveTestBinaryReason, overrideSet: boolean) {
    const copy = LIVE_TEST_BINARY_COPY[reason];
    super(
      `${copy.subject(path)}${overrideSet ? copy.override : ""} Run (cd core && bun run build) or set LANDO_SCENARIO_E2E_BINARY.`,
    );
    this.name = "MissingLiveTestBinaryError";
    this.path = path;
    this.reason = reason;
  }
}

export const resolveLiveTestBinaryPath = (cwd: string, env: Env): string =>
  resolve(cwd, env.LANDO_SCENARIO_E2E_BINARY ?? "core/dist/lando");

export const assertLiveTestBinary = async (cwd: string, env: Env): Promise<string> => {
  const path = resolveLiveTestBinaryPath(cwd, env);
  const overrideSet = env.LANDO_SCENARIO_E2E_BINARY !== undefined;
  try {
    const info = await stat(path);
    if (info.isDirectory()) throw new MissingLiveTestBinaryError(path, "directory", overrideSet);
    await access(path, constants.X_OK);
  } catch (cause) {
    if (cause instanceof MissingLiveTestBinaryError) throw cause;
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      throw new MissingLiveTestBinaryError(path, "missing", overrideSet);
    }
    throw new MissingLiveTestBinaryError(path, "not-executable", overrideSet);
  }
  return path;
};

async function allocateLiveTestRoots(env: Env, cwd: string): Promise<TempRootRetirement | undefined> {
  const endpoint = env.LANDO_TEST_PODMAN_SOCKET;
  if (
    !endpoint ||
    env.LANDO_TEST_USE_REAL_ROOTS === "1" ||
    TEST_ROOT_ENV_KEYS.some((key) => env[key] !== undefined)
  ) {
    return undefined;
  }
  await assertLiveTestBinary(cwd, env);
  return ownedLiveTestRoots(await mkdtemp(join(tmpdir(), "lando-live-test-roots-")), endpoint, env, cwd);
}

/** The roots, environment, and CLI the runner binds to one owned directory and endpoint. */
function ownedLiveTestRoots(directory: string, endpoint: string, env: Env, cwd: string): TempRootRetirement {
  const binary = resolveLiveTestBinaryPath(cwd, env);
  return {
    directory,
    endpoint,
    command: [binary],
    env: Object.freeze({
      ...env,
      ...tempPodmanRootEnv(directory, endpoint),
      LANDO_SCENARIO_E2E_BINARY: binary,
    }),
  };
}

/**
 * Runs the per-root part of `lando setup` (provider and local CA tooling) so routed scenarios can
 * issue certificates. Host-global steps (router helper, shell profile, file-sync engine, trust
 * store) are skipped: they belong to the caller's installation, not to disposable roots.
 */
async function prepareLiveTestRoots(owned: TempRootRetirement, track: TrackTestChild): Promise<number> {
  const setup = Bun.spawn([...owned.command, ...TEMP_PODMAN_ROOT_SETUP_ARGS], {
    cwd: owned.directory,
    env: owned.env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    timeout: 120_000,
    killSignal: "SIGKILL",
  });
  track(setup);
  return setup.exited;
}

export async function runWithLiveTestRoots(
  options: { readonly live: boolean; readonly cwd: string; readonly env: Env },
  run: (env: Env, track: TrackTestChild) => Promise<number>,
  retire: (owned: TempRootRetirement) => Promise<RetirementResult> = retireTempRoots,
  prepare: (owned: TempRootRetirement, track: TrackTestChild) => Promise<number> = prepareLiveTestRoots,
): Promise<number> {
  let child: TestChild | undefined;
  let received: RunnerSignal | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const forward = () => {
    if (child === undefined || received === undefined || child.exitCode !== null || child.signalCode !== null)
      return;
    const target = child;
    target.kill(received);
    escalation = setTimeout(() => {
      if (target.exitCode === null && target.signalCode === null) target.kill("SIGKILL");
    }, 5_000);
    void target.exited.finally(() => clearTimeout(escalation));
  };
  const onSignal = (signal: RunnerSignal) => {
    if (received !== undefined) return;
    received = signal;
    forward();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  let owned: TempRootRetirement | undefined;
  let testExitCode: number | undefined;
  let retirementFailed = false;
  try {
    owned = options.live ? await allocateLiveTestRoots(options.env, options.cwd) : undefined;
    const track: TrackTestChild = (proc) => {
      child = proc;
      forward();
    };
    const prepared = owned === undefined || received !== undefined ? 0 : await prepare(owned, track);
    if (prepared !== 0) testExitCode = prepared;
    else if (received === undefined) testExitCode = await run(owned?.env ?? options.env, track);
  } catch (error) {
    if (received === undefined) throw error;
  } finally {
    try {
      if (child !== undefined) {
        if (received === undefined && child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        const reapedStatus = await child.exited;
        testExitCode ??= reapedStatus;
      }
      if (owned !== undefined) {
        const { retained, failed } = await retire(owned).catch(
          (error: unknown): RetirementResult => ({
            removed: [],
            retained: [],
            failed: [
              {
                target: "retirement",
                reason: causeMessage(error),
                _tag: "RetirementDefect",
                remediation: "Preserve the temporary roots and investigate the retirement failure.",
              },
            ],
          }),
        );
        retirementFailed = retained.length > 0 || failed.length > 0;
        if (retirementFailed) {
          console.error(
            "[live tests] temporary root retirement failed",
            JSON.stringify({
              testExitCode: testExitCode ?? null,
              directory: owned.directory,
              endpoint: owned.endpoint,
              retained,
              failed,
              retry: `bun scripts/live-test-roots.ts retire ${owned.directory}`,
            }),
          );
        }
      }
    } finally {
      clearTimeout(escalation);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  }
  if (received !== undefined) return SIGNAL_EXIT_CODES[received];
  return testExitCode || (retirementFailed ? 1 : 0);
}

if (import.meta.main) {
  const [command, directory] = Bun.argv.slice(2);
  const endpoint = process.env.LANDO_TEST_PODMAN_SOCKET;
  if (command !== "retire" || directory === undefined || !endpoint) {
    console.error(
      "usage: LANDO_TEST_PODMAN_SOCKET=<socket> bun scripts/live-test-roots.ts retire <directory>\n" +
        "Retires roots laid out as <directory>/lando_user_data_root, lando_user_conf_root, " +
        "lando_user_cache_root, and lando_system_plugin_root.",
    );
    process.exit(2);
  }
  try {
    await assertLiveTestBinary(process.cwd(), process.env);
  } catch (error) {
    if (error instanceof MissingLiveTestBinaryError) {
      console.error(error.message);
      process.exit(2);
    }
    throw error;
  }
  const owned = ownedLiveTestRoots(resolve(directory), endpoint, process.env, process.cwd());
  const result = await retireTempRoots(owned);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.retained.length > 0 || result.failed.length > 0 ? 1 : 0);
}
