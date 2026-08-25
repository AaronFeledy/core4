import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Schema } from "effect";

import { CommandResultEnvelope } from "@lando/sdk/schema";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");
const bunBinDir = dirname(process.execPath);
const bunDebugProbe = resolve(import.meta.dirname, "fixtures/log-level-bun-debug-probe.ts");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface CommandEnvelope {
  readonly command?: string;
  readonly ok?: boolean;
  readonly error?: { readonly _tag?: string };
}

let stateDir = "";
let confDir = "";

beforeAll(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "lando-log-level-run-data-"));
  confDir = await mkdtemp(join(tmpdir(), "lando-log-level-run-conf-"));
});

afterAll(async () => {
  if (stateDir.length > 0) await rm(stateDir, { recursive: true, force: true });
  if (confDir.length > 0) await rm(confDir, { recursive: true, force: true });
});

const isolationEnv = (): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${bunBinDir}:${process.env.PATH ?? ""}`,
    LANDO_USER_DATA_ROOT: stateDir,
    LANDO_USER_CONF_ROOT: confDir,
    LANDO_USER_CACHE_ROOT: stateDir,
  };
  env.LANDO_DEBUG = undefined;
  env.LANDO_LOG_LEVEL = undefined;
  env.LANDO_RENDERER = undefined;
  return env;
};

const runSourceCli = async (args: ReadonlyArray<string>): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...args],
    cwd: repoRoot,
    env: isolationEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

const parseEnvelope = (stdout: string): CommandEnvelope => JSON.parse(stdout) as CommandEnvelope;

const decodeEnvelope = (stdout: string) =>
  Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(stdout));

const hasCursorUpOrErase = (text: string): boolean => {
  const esc = String.fromCharCode(27);
  return new RegExp(`${esc}\\[[0-9]*[AJ]`).test(text);
};

describe("log-level run-path wiring", () => {
  test("strips --debug so it is not an unknown command flag", async () => {
    // Given a normal command plus the universal debug flag and an explicit json renderer.
    const args = ["version", "--debug", "--renderer=json"] as const;

    // When the native dispatcher runs it.
    const result = await runSourceCli(args);

    // Then --debug is consumed before command flag validation.
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("UnknownCliFlagError");
    expect(parseEnvelope(result.stdout)).toMatchObject({
      command: "meta:version",
      ok: true,
    });
  }, 60_000);

  test("rejects --log-level=nope as a pre-command LogLevelSelectionError", async () => {
    // Given an unsupported log-level token and machine-output intent.
    const args = ["version", "--log-level=nope", "--format=json"] as const;

    // When the native dispatcher resolves log level.
    const result = await runSourceCli(args);

    // Then the failure is tagged before command lifecycle.
    expect(result.exitCode).not.toBe(0);
    const envelope = parseEnvelope(result.stdout);
    expect(envelope.command).toBe("cli:log-level-selection");
    expect(envelope.ok).toBe(false);
    expect(envelope.error?._tag).toBe("LogLevelSelectionError");
  }, 60_000);

  test("forwards --debug through bun passthrough", async () => {
    // Given lando bun invoking a script that reports whether --debug survived.
    const args = ["bun", bunDebugProbe, "--debug"] as const;

    // When the bun passthrough path runs.
    const result = await runSourceCli(args);

    // Then extraction is skipped and --debug remains on the child argv.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("debug-kept");
  }, 30_000);

  test("does not treat bun --log-level=nope as a Lando pre-command error", async () => {
    // Given a bun payload that includes an invalid Lando log-level flag.
    const args = ["bun", "--log-level=nope", "-e", "process.stdout.write('bun-passthrough')"] as const;

    // When the bun passthrough path runs.
    const result = await runSourceCli(args);

    // Then Lando does not extract or validate the flag.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("bun-passthrough");
    expect(result.stderr).not.toContain("LogLevelSelectionError");
  }, 30_000);
});

describe("host-safe debug machine output", () => {
  test("json renderer plus debug emits a schema-valid success envelope on stdout only", async () => {
    // Given version with an explicit json renderer and --debug.
    const args = ["version", "--renderer=json", "--debug"] as const;

    // When the native CLI runs with stdout and stderr captured separately.
    const result = await runSourceCli(args);

    // Then stdout is a v4 success envelope and stderr is not mixed into it.
    expect(result.exitCode).toBe(0);
    const envelope = decodeEnvelope(result.stdout);
    expect(envelope.apiVersion).toBe("v4");
    expect(envelope.command).toBe("meta:version");
    expect(envelope.ok).toBe(true);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    if (result.stderr.length > 0) {
      expect(result.stdout).not.toContain(result.stderr);
    }
  }, 60_000);

  test("unknown --log-level=nope is a tagged failure, not a success envelope", async () => {
    // Given a malformed log-level token and no machine-output flag.
    const args = ["version", "--log-level=nope"] as const;

    // When the native CLI resolves log level.
    const result = await runSourceCli(args);

    // Then the process fails with LogLevelSelectionError, not ok:true.
    expect(result.exitCode).not.toBe(0);
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined).toContain("LogLevelSelectionError");
    expect(combined).toContain("cli:log-level-selection");
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined && typeof parsed === "object" && parsed !== null && "ok" in parsed) {
      expect(parsed.ok).not.toBe(true);
    }
  }, 60_000);

  test("default --debug uses verbose payload traces without OpenTUI frames", async () => {
    // Given version with --debug and no explicit renderer.
    const args = ["version", "--debug"] as const;

    // When the native CLI runs.
    const result = await runSourceCli(args);

    // Then the verbose dump includes a payload _tag and no live-frame bytes.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"_tag"');
    expect(result.stdout).not.toContain("LANDO OPS");
    expect(hasCursorUpOrErase(result.stdout)).toBe(false);
    expect(hasCursorUpOrErase(result.stderr)).toBe(false);
  }, 60_000);
});
