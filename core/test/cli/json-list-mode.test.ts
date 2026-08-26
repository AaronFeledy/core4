import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { listSelectableResultKeys } from "@lando/sdk/command-result";

import { resolveBuiltInCommand } from "../../src/cli/built-in-command-registry.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");
const bunBinDir = dirname(process.execPath);

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

let stateDir = "";
let confDir = "";

beforeAll(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "lando-json-list-data-"));
  confDir = await mkdtemp(join(tmpdir(), "lando-json-list-conf-"));
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

const versionKeys = (): readonly string[] => {
  const spec = resolveBuiltInCommand("meta:version")?.spec;
  if (spec === undefined) throw new Error("missing meta:version spec");
  return listSelectableResultKeys(spec.resultSchema);
};

describe("json list-mode dispatch", () => {
  test("bare --json after version prints selectable keys and does not run the command", async () => {
    // Given the version command plus bare --json.
    const args = ["version", "--json"] as const;

    // When the native dispatcher runs it.
    const result = await runSourceCli(args);

    // Then stdout is the resultSchema key array, not a command envelope.
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([...versionKeys()]);
    expect(result.stdout).not.toContain("apiVersion");
  }, 60_000);

  test("meta:version --json --jq . exits 2 with JsonJqConflictError", async () => {
    // Given list-mode --json combined with --jq.
    const args = ["meta:version", "--json", "--jq", "."] as const;

    // When the native dispatcher resolves json control.
    const result = await runSourceCli(args);

    // Then the conflict is a tagged pre-command failure.
    expect(result.exitCode).toBe(2);
    const envelope = JSON.parse(result.stdout) as {
      readonly ok?: boolean;
      readonly error?: { readonly _tag?: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error?._tag).toBe("JsonJqConflictError");
  }, 60_000);

  test("help --json still prints the help catalog envelope", async () => {
    // Given the help command plus --json.
    const args = ["help", "--json"] as const;

    // When the native dispatcher runs it.
    const result = await runSourceCli(args);

    // Then the catalog envelope is unchanged.
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout) as {
      readonly apiVersion?: string;
      readonly command?: string;
      readonly ok?: boolean;
    };
    expect(envelope.apiVersion).toBe("v4");
    expect(envelope.command).toBe("cli:help");
    expect(envelope.ok).toBe(true);
  }, 60_000);

  test("no-command --json still prints root help text", async () => {
    // Given bare --json with no resolved command.
    const args = ["--json"] as const;

    // When the native dispatcher runs it.
    const result = await runSourceCli(args);

    // Then root help text is unchanged (not a key array).
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("USAGE");
    expect(() => JSON.parse(result.stdout)).toThrow();
  }, 60_000);

  test("--json=core runs version and projects that key", async () => {
    // Given equals-form projection on version.
    const args = ["version", "--json=core"] as const;

    // When the native dispatcher runs it.
    const result = await runSourceCli(args);

    // Then the command runs and envelope.result contains only that key.
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout) as {
      readonly ok?: boolean;
      readonly command?: string;
      readonly result?: Record<string, unknown>;
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toBe("meta:version");
    expect(envelope.result).toEqual({ core: expect.any(String) });
    expect(envelope.result).not.toHaveProperty("bun");
  }, 60_000);
});
