/**
 * Compiled-binary dispatch parity tests.
 *
 * `@oclif/core`'s `execute()` cannot dispatch inside a `bun build --compile`
 * single-file binary, so source-mode OCLIF `execute()` and the compiled
 * hand-rolled `runCompiledCli` stay as separate dispatch paths. These tests
 * enforce parity across every command id that is implemented or deliberately
 * deferred in the compiled registry.
 *
 * Two parts:
 *
 *   Part 1 — structural parity (no spawn; runs on every platform). The canonical
 *   command-id universe is `Object.keys(compiledCommands)`. Every id is
 *   classified as exactly one of implemented or deferred; every implemented id has a
 *   compiled-dispatch branch in `core/src/cli/run.ts`; every deferred id has a
 *   registered deferral plan and NO bespoke dispatch branch (it routes through
 *   the generic `notImplementedErrorForCommand` fallthrough). This exhaustively
 *   covers every canonical command id.
 *
 *   Part 2 — behavioral parity (drives the compiled binary on linux-x64). The
 *   source and compiled paths are semantically identical for representative implemented commands
 *   (including `meta:version` / `meta:shellenv`, whose canonical forms must
 *   dispatch — not emit `NotImplementedError`) and for the deferred set.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { DEFERRED_COMMAND_PLANS, deferredCommandPlan } from "../../../src/cli/deferred-commands.ts";
import { isCanonicalLandoCommandId, isMvpCommandId } from "../../../src/cli/oclif/command-base.ts";
import compiledCommands from "../../../src/cli/oclif/compiled-commands.ts";
import { listTree, pathsOutsidePrefixes } from "../_util/fs-tree.ts";
import { errorCodeFromStderr, normalizeJsonEnvelope, normalizeOutput } from "./normalize.ts";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const coreRoot = resolve(repoRoot, "core");
const runSourcePath = resolve(coreRoot, "src/cli/run.ts");
const sourceCli = resolve(coreRoot, "bin/lando.ts");
const compiledBinary = resolve(coreRoot, "dist/lando");

const CANONICAL_IDS: ReadonlyArray<string> = Object.keys(compiledCommands).sort();
const MVP_IDS: ReadonlyArray<string> = CANONICAL_IDS.filter(isMvpCommandId);
const DEFERRED_IDS: ReadonlyArray<string> = [...DEFERRED_COMMAND_PLANS.keys()].sort();

const runSource = readFileSync(runSourcePath, "utf-8");

/**
 * A canonical id has a compiled-dispatch branch when `runCompiledCli` compares
 * `argv[0]` against it (the `argv[0] === "<id>"` switch).
 *
 * The match is anchored to the actual dispatch comparison rather than a bare
 * quoted literal: several canonical ids legitimately appear elsewhere in
 * `run.ts` (argv normalization, passthrough guards, deferred-error parsing), so
 * a loose substring check would still pass if a real dispatch branch were
 * deleted. Anchoring to `argv[0] === "<id>"` makes deleting the branch a
 * detectable regression.
 */
const hasCompiledDispatchBranch = (id: string): boolean => {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`argv\\[0\\]\\s*===\\s*"${escaped}"`).test(runSource);
};

describe("compiled-binary dispatch parity — structural", () => {
  test("the canonical command-id universe is non-empty and fully canonical", () => {
    expect(CANONICAL_IDS.length).toBeGreaterThan(0);
    for (const id of CANONICAL_IDS) {
      expect(isCanonicalLandoCommandId(id), `${id} must be a canonical namespaced id`).toBe(true);
    }
  });

  test("every canonical id is classified as exactly one of MVP-implemented or deferred", () => {
    for (const id of CANONICAL_IDS) {
      const mvp = isMvpCommandId(id);
      const deferred = deferredCommandPlan(id) !== undefined;
      expect(
        mvp !== deferred,
        `${id} must be exactly one of MVP-implemented or deferred (mvp=${mvp}, deferred=${deferred})`,
      ).toBe(true);
    }
  });

  test("the MVP and deferred sets partition the registry (exhaustive, disjoint)", () => {
    const partition = new Set([...MVP_IDS, ...DEFERRED_IDS]);
    expect(partition.size, "MVP and deferred sets must be disjoint").toBe(
      MVP_IDS.length + DEFERRED_IDS.length,
    );
    expect([...partition].sort()).toEqual([...CANONICAL_IDS]);
  });

  test("every MVP canonical id has a compiled-dispatch branch in run.ts", () => {
    const missing = MVP_IDS.filter((id) => !hasCompiledDispatchBranch(id));
    expect(missing, "every MVP id must have an argv[0] dispatch branch in core/src/cli/run.ts").toEqual([]);
  });

  test("every deferred canonical id has a registered plan and no bespoke dispatch branch", () => {
    for (const id of DEFERRED_IDS) {
      expect(deferredCommandPlan(id), `${id} must have a registered deferral plan`).toBeDefined();
      expect(
        hasCompiledDispatchBranch(id),
        `${id} must route through the generic NotImplementedError fallthrough, not a bespoke branch`,
      ).toBe(false);
    }
  });

  test("compiled scratch commands thread resolved deprecation suppression into the renderer boundary", () => {
    const start = runSource.indexOf("const runScratchEffect =");
    const end = runSource.indexOf("export const parseScratchStartArgv", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(runSource.slice(start, end)).toContain("deprecationWarnings: activeDeprecationWarnings");
  });
});

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface RunProcessOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly stdin?: string;
}

const runProcess = async (
  cmd: ReadonlyArray<string>,
  options: RunProcessOptions = {},
): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [...cmd],
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: options.stdin === undefined ? "ignore" : "pipe",
  });
  if (options.stdin !== undefined && proc.stdin !== undefined) {
    proc.stdin.write(options.stdin);
    proc.stdin.end();
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

const runSourceCli = (args: ReadonlyArray<string>, opts?: RunProcessOptions) =>
  runProcess([process.execPath, sourceCli, ...args], opts);

const runCompiledCli = (args: ReadonlyArray<string>, opts?: RunProcessOptions) =>
  runProcess([compiledBinary, ...args], opts);

/**
 * Throwaway `LANDO_USER_*` roots so uninstall planning reads test-owned dirs,
 * not the host's real Lando state. The identical env feeds both dispatch paths,
 * so any path in the plan matches across paths (and the normalizer collapses it).
 */
const makeIsolatedEnv = (): { readonly env: Record<string, string>; readonly cleanup: () => void } => {
  const root = mkdtempSync(join(tmpdir(), "lando-parity-roots-"));
  const env = {
    ...process.env,
    LANDO_USER_DATA_ROOT: join(root, "data"),
    LANDO_USER_CACHE_ROOT: join(root, "cache"),
    LANDO_USER_CONF_ROOT: join(root, "conf"),
  } as Record<string, string>;
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "LANDO_NETWORK_CA_CERTS",
  ]) {
    Reflect.deleteProperty(env, key);
  }
  return { env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

const envPath = (env: Record<string, string>, key: string): string => {
  const value = env[key];
  if (value === undefined) {
    throw new Error(`Missing isolated env path: ${key}`);
  }
  return value;
};

const makePluginTestFixture = (): { readonly root: string; readonly cleanup: () => void } => {
  const root = mkdtempSync(join(tmpdir(), "lando-parity-plugin-test-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({
      name: "@acme/lando-plugin-parity",
      version: "0.0.0",
      type: "module",
      landoPlugin: {
        name: "@acme/lando-plugin-parity",
        version: "0.0.0",
        api: 4,
        entry: "src/index.ts",
      },
    })}\n`,
  );
  writeFileSync(join(root, "src", "index.ts"), "export const ok = true;\n");
  writeFileSync(
    join(root, "test", "plugin.test.ts"),
    'import { expect, test } from "bun:test"; test("ok", () => expect(true).toBe(true));\n',
  );
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

const makePluginBuildMixedTreeFixture = (): { readonly root: string; readonly cleanup: () => void } => {
  const root = mkdtempSync(join(tmpdir(), "lando-parity-plugin-build-"));
  mkdirSync(join(root, "src", "dist"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({
      name: "@acme/lando-plugin-build-parity",
      version: "0.0.0",
      type: "module",
      exports: { ".": "./src/index.ts" },
      landoPlugin: {
        name: "@acme/lando-plugin-build-parity",
        version: "0.0.0",
        api: 4,
        entry: "src/index.ts",
      },
    })}\n`,
  );
  writeFileSync(join(root, "src", "index.ts"), "export const ok = true;\n");
  writeFileSync(join(root, "src", "dist", "stale.js"), "export {};\n");
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

const makePluginPackageFixture = (
  name: string,
  prefix: string,
): { readonly root: string; readonly cleanup: () => void } => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({
      name,
      version: "1.2.3",
      type: "module",
      exports: { ".": "./src/index.ts" },
      landoPlugin: { name, version: "1.2.3", api: 4, entry: "src/index.ts" },
    })}\n`,
  );
  writeFileSync(join(root, "src", "index.ts"), "export const ok = true;\n");
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

/** A plugin with a fresh dist/ so publish dry-run skips the rebuild (no Bun spawn). */
const makePluginPublishFreshFixture = (): { readonly root: string; readonly cleanup: () => void } => {
  const fixture = makePluginPackageFixture(
    "@acme/lando-plugin-publish-parity",
    "lando-parity-plugin-publish-",
  );
  mkdirSync(join(fixture.root, "dist"), { recursive: true });
  writeFileSync(join(fixture.root, "dist", "index.js"), "export const ok = true;\n");
  writeFileSync(join(fixture.root, "dist", "index.d.ts"), "export declare const ok = true;\n");
  writeFileSync(
    join(fixture.root, "dist", "package.json"),
    `${JSON.stringify({ name: "@acme/lando-plugin-publish-parity", version: "1.2.3" })}\n`,
  );
  const future = new Date(Date.now() + 60_000);
  for (const file of ["index.js", "index.d.ts", "package.json"])
    utimesSync(join(fixture.root, "dist", file), future, future);
  return fixture;
};

const sha256 = (content: string): string => createHash("sha256").update(content).digest("hex");

const makeIncludesUpdateFixture = (): {
  readonly root: string;
  readonly env: Record<string, string>;
  readonly cleanup: () => void;
} => {
  const root = mkdtempSync(join(tmpdir(), "lando-parity-includes-update-"));
  const appRoot = join(root, "app");
  const cacheRoot = join(root, "cache");
  const fragment = "services:\n  db:\n    type: postgres\n";
  mkdirSync(join(cacheRoot, "includes", "git", "abc111"), { recursive: true });
  mkdirSync(appRoot, { recursive: true });
  writeFileSync(join(cacheRoot, "includes", "git", "abc111", "db.yml"), fragment);
  writeFileSync(
    join(appRoot, ".lando.yml"),
    [
      "name: includesupdateparity",
      "includes:",
      "  - source: github:acme/one",
      "    path: db.yml",
      "  - source: github:acme/two",
      "    path: db.yml",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(appRoot, ".lando.lock.yml"),
    [
      "# DO NOT EDIT - generated by Lando.",
      "includes:",
      "  - source: github:acme/one/db.yml",
      "    resolved: abc111",
      `    checksum: ${sha256(fragment)}`,
      "  - source: github:acme/two/db.yml",
      "    resolved: old2",
      `    checksum: ${"0".repeat(64)}`,
      "",
    ].join("\n"),
  );
  return {
    root: appRoot,
    env: { ...process.env, LANDO_USER_CACHE_ROOT: cacheRoot } as Record<string, string>,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};

const forceIncludesChecksumDrift = (root: string): void => {
  const lockfile = join(root, ".lando.lock.yml");
  const current = readFileSync(lockfile, "utf-8");
  writeFileSync(lockfile, current.replace(/checksum: [a-f0-9]{64}/u, `checksum: ${"1".repeat(64)}`));
};

const lastJsonLine = (output: string): unknown => {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") && line.endsWith("}"));
  const line = lines.at(-1);
  if (line === undefined) throw new Error(`no JSON envelope found in output: ${output.slice(0, 200)}`);
  return JSON.parse(line);
};

const expectUnknownFlagParity = async (argv: ReadonlyArray<string>, flag: string): Promise<void> => {
  const source = await runSourceCli(argv);
  const compiled = await runCompiledCli(argv);
  expect(source.exitCode, `source stderr: ${source.stderr}`).toBe(2);
  expect(compiled.exitCode, `compiled stderr: ${compiled.stderr}`).toBe(source.exitCode);
  expect(compiled.stdout).toBe("");
  expect(source.stderr).toContain(`Nonexistent flag: ${flag}`);
  expect(compiled.stderr).toContain(`Nonexistent flag: ${flag}`);
};

const expectHelpParity = async (commandId: string, mustContain: ReadonlyArray<string>): Promise<void> => {
  const source = await runSourceCli([commandId, "--help"]);
  const compiled = await runCompiledCli([commandId, "--help"]);
  expect(source.exitCode, `source stderr: ${source.stderr}`).toBe(0);
  expect(compiled.exitCode, `compiled stderr: ${compiled.stderr}`).toBe(source.exitCode);
  for (const text of mustContain) {
    expect(source.stdout, `source help missing ${text}`).toContain(text);
    expect(compiled.stdout, `compiled help missing ${text}`).toContain(text);
  }
};

const expectJsonEnvelopeParity = async (
  argv: ReadonlyArray<string>,
  expectedCode: string,
  opts: { readonly cwd?: string; readonly env?: Record<string, string>; readonly exitCode?: number } = {},
): Promise<void> => {
  const source = await runSourceCli([...argv, "--renderer=json"], opts);
  const compiled = await runCompiledCli([...argv, "--renderer=json"], opts);
  expect(source.exitCode, `source stderr: ${source.stderr}`).toBe(opts.exitCode ?? 1);
  expect(compiled.exitCode, `compiled stderr: ${compiled.stderr}`).toBe(source.exitCode);
  const sourceEnvelope = normalizeJsonEnvelope(lastJsonLine(source.stdout || source.stderr));
  const compiledEnvelope = normalizeJsonEnvelope(lastJsonLine(compiled.stdout || compiled.stderr));
  expect(compiledEnvelope).toEqual(sourceEnvelope);
  expect(sourceEnvelope.code).toBe(expectedCode);
};

const isLinuxX64 = process.platform === "linux" && process.arch === "x64";

describe.skipIf(!isLinuxX64)("compiled-binary dispatch parity — behavioral", () => {
  beforeAll(async () => {
    const build = await runProcess([process.execPath, "run", "build:compile"], { cwd: coreRoot });
    expect(build.exitCode, `build:compile failed: ${build.stderr}`).toBe(0);
  }, 240_000);

  describe("MVP canonical ids dispatch (not NotImplementedError) at parity", () => {
    test("meta:version: both paths exit 0 with the same version line", async () => {
      const source = await runSourceCli(["meta:version"]);
      const compiled = await runCompiledCli(["meta:version"]);
      expect(source.exitCode, `source stderr: ${source.stderr}`).toBe(0);
      expect(compiled.exitCode, `compiled stderr: ${compiled.stderr}`).toBe(0);
      expect(compiled.stderr).not.toContain("NotImplementedError");
      expect(normalizeOutput(compiled.stdout)).toBe(normalizeOutput(source.stdout));
    }, 30_000);

    test("version: top-level alias supports machine output in both dispatch paths", async () => {
      const source = await runSourceCli(["version", "--format=json"]);
      const compiled = await runCompiledCli(["version", "--format=json"]);
      expect(source.exitCode, `source stderr: ${source.stderr}`).toBe(0);
      expect(compiled.exitCode, `compiled stderr: ${compiled.stderr}`).toBe(0);
      const sourceEnvelope = normalizeJsonEnvelope(lastJsonLine(source.stdout));
      const compiledEnvelope = normalizeJsonEnvelope(lastJsonLine(compiled.stdout));
      expect(compiledEnvelope).toEqual(sourceEnvelope);
      expect(compiledEnvelope.command).toBe("meta:version");
    }, 30_000);

    test("meta:shellenv: both paths exit 0 with the same shell snippet", async () => {
      const source = await runSourceCli(["meta:shellenv"]);
      const compiled = await runCompiledCli(["meta:shellenv"]);
      expect(source.exitCode, `source stderr: ${source.stderr}`).toBe(0);
      expect(compiled.exitCode, `compiled stderr: ${compiled.stderr}`).toBe(0);
      expect(compiled.stderr).not.toContain("NotImplementedError");
      // Install dir differs (source checkout vs compiled binary location); the
      // shared normalizer neutralizes the absolute path so the snippet shape
      // is compared for equality.
      expect(normalizeOutput(compiled.stdout)).toBe(normalizeOutput(source.stdout));
    }, 30_000);

    test("app config translate: space-separated form dispatches like the canonical id", async () => {
      const source = await runSourceCli(["app", "config", "translate", "--list", "--format=json"]);
      const compiled = await runCompiledCli(["app", "config", "translate", "--list", "--format=json"]);
      expect(source.exitCode, `source stderr: ${source.stderr}`).toBe(0);
      expect(compiled.exitCode, `compiled stderr: ${compiled.stderr}`).toBe(source.exitCode);
      const sourceEnvelope = normalizeJsonEnvelope(lastJsonLine(source.stdout));
      const compiledEnvelope = normalizeJsonEnvelope(lastJsonLine(compiled.stdout));
      expect(compiledEnvelope).toEqual(sourceEnvelope);
      expect(compiledEnvelope.command).toBe("app:config:translate");
    }, 30_000);

    test("app includes update: space-separated source scope dispatches like the canonical id", async () => {
      const sourceFixture = makeIncludesUpdateFixture();
      const compiledFixture = makeIncludesUpdateFixture();
      try {
        const args = ["app", "includes", "update", "github:acme/one", "--no-network", "--format=json"];
        const source = await runSourceCli(args, { cwd: sourceFixture.root, env: sourceFixture.env });
        const compiled = await runCompiledCli(args, { cwd: compiledFixture.root, env: compiledFixture.env });
        expect(source.exitCode, `source stderr: ${source.stderr}`).toBe(0);
        expect(compiled.exitCode, `compiled stderr: ${compiled.stderr}`).toBe(source.exitCode);
        const sourceEnvelope = normalizeJsonEnvelope(lastJsonLine(source.stdout));
        const compiledEnvelope = normalizeJsonEnvelope(lastJsonLine(compiled.stdout));
        expect(sourceEnvelope.command).toBe("app:includes:update");
        expect(compiledEnvelope.command).toBe("app:includes:update");
        expect(compiledEnvelope).toMatchObject({
          ok: true,
          result: {
            noNetwork: true,
            requestedSources: ["github:acme/one"],
            entries: [{ source: "github:acme/one/db.yml", status: "unchanged" }],
          },
        });
      } finally {
        sourceFixture.cleanup();
        compiledFixture.cleanup();
      }
    }, 30_000);

    test("app includes update: check-mode JSON exits non-zero when scoped offline drift is found", async () => {
      const sourceFixture = makeIncludesUpdateFixture();
      const compiledFixture = makeIncludesUpdateFixture();
      try {
        forceIncludesChecksumDrift(sourceFixture.root);
        forceIncludesChecksumDrift(compiledFixture.root);
        const args = [
          "app",
          "includes",
          "update",
          "github:acme/one",
          "--no-network",
          "--check",
          "--format=json",
        ];
        const source = await runSourceCli(args, { cwd: sourceFixture.root, env: sourceFixture.env });
        const compiled = await runCompiledCli(args, { cwd: compiledFixture.root, env: compiledFixture.env });
        expect(source.exitCode, `source stderr: ${source.stderr}`).toBe(1);
        expect(compiled.exitCode, `compiled stderr: ${compiled.stderr}`).toBe(source.exitCode);
        const sourceEnvelope = normalizeJsonEnvelope(lastJsonLine(source.stdout));
        const compiledEnvelope = normalizeJsonEnvelope(lastJsonLine(compiled.stdout));
        expect(sourceEnvelope).toMatchObject({
          command: "app:includes:update",
          ok: true,
          result: { checkMode: true, drift: true, wrote: false, noNetwork: true },
        });
        expect(compiledEnvelope).toMatchObject({
          command: "app:includes:update",
          ok: true,
          result: { checkMode: true, drift: true, wrote: false, noNetwork: true },
        });
      } finally {
        sourceFixture.cleanup();
        compiledFixture.cleanup();
      }
    }, 30_000);

    test("meta:shellenv invalid --shell fails on both paths", async () => {
      const source = await runSourceCli(["meta:shellenv", "--shell=fish"]);
      const compiled = await runCompiledCli(["meta:shellenv", "--shell=fish"]);

      expect(source.exitCode).toBe(2);
      expect(compiled.exitCode).toBe(source.exitCode);
      expect(compiled.stdout).toBe("");
      expect(compiled.stderr).toContain("Expected --shell=fish to be one of: posix, powershell, pwsh");
    }, 30_000);

    test("meta:shellenv missing --shell value fails on both paths", async () => {
      const source = await runSourceCli(["meta:shellenv", "--shell"]);
      const compiled = await runCompiledCli(["meta:shellenv", "--shell"]);

      expect(source.exitCode).toBe(2);
      expect(compiled.exitCode).toBe(source.exitCode);
      expect(compiled.stdout).toBe("");
      expect(compiled.stderr).toContain("Flag --shell expects one of these values: posix, powershell, pwsh");
    }, 30_000);

    test("shell rejects a bare positional service name on both paths", async () => {
      const source = await runSourceCli(["shell", "web"]);
      const compiled = await runCompiledCli(["shell", "web"]);

      expect(source.exitCode).toBe(2);
      expect(compiled.exitCode).toBe(source.exitCode);
      expect(compiled.stdout).toBe("");
      // Source-mode OCLIF topic resolution intercepts `shell web` as the id
      // `shell:web` before arg validation; compiled dispatch reaches the
      // command's argv validation. Both reject loudly with exit 2 instead of
      // silently opening a host shell.
      expect(source.stderr).toContain("command shell:web not found");
      expect(compiled.stderr).toContain("Unexpected argument: web");
    }, 30_000);

    test("open rejects unknown flags on both paths", async () => {
      await expectUnknownFlagParity(
        ["open", "--definitely-not-an-open-flag"],
        "--definitely-not-an-open-flag",
      );
    }, 30_000);

    test("open rejects arbitrary positional URLs on both paths", async () => {
      const source = await runSourceCli(["open", "https://example.test"]);
      const compiled = await runCompiledCli(["open", "https://example.test"]);

      expect(source.exitCode).toBe(2);
      expect(compiled.exitCode).toBe(source.exitCode);
      expect(compiled.stdout).toBe("");
      expect(compiled.stderr).toContain("Unexpected argument: https://example.test");
    }, 30_000);

    test("shell --service followed by another flag fails on both paths instead of eating it", async () => {
      const source = await runSourceCli(["shell", "--service", "--no-history"]);
      const compiled = await runCompiledCli(["shell", "--service", "--no-history"]);

      expect(source.exitCode).toBe(2);
      expect(compiled.exitCode).toBe(source.exitCode);
      expect(compiled.stdout).toBe("");
      expect(source.stderr).toContain("Flag --service expects a value");
      expect(compiled.stderr).toContain("Flag --service expects a value");
    }, 30_000);

    test("shellenv alias rejects unknown flags on both paths", async () => {
      const source = await runSourceCli(["shellenv", "--definitely-not-a-shellenv-flag"]);
      const compiled = await runCompiledCli(["shellenv", "--definitely-not-a-shellenv-flag"]);

      expect(source.exitCode).toBe(2);
      expect(compiled.exitCode).toBe(source.exitCode);
      expect(compiled.stdout).toBe("");
      expect(compiled.stderr).toContain("Nonexistent flag: --definitely-not-a-shellenv-flag");
    }, 30_000);

    test("setup alias rejects unknown flags on both paths", async () => {
      const source = await runSourceCli(["setup", "--definitely-not-a-setup-flag"]);
      const compiled = await runCompiledCli(["setup", "--definitely-not-a-setup-flag"]);

      expect(source.exitCode).toBe(2);
      expect(compiled.exitCode).toBe(source.exitCode);
      expect(compiled.stdout).toBe("");
      expect(compiled.stderr).toContain("Nonexistent flag: --definitely-not-a-setup-flag");
    }, 30_000);

    test("meta:setup help exposes provider-contributed flags on both paths", async () => {
      await expectHelpParity("meta:setup", ["--runtime-bundle-url", "--runtime-bundle-sha256"]);
    }, 30_000);

    test("app:includes:update help exposes source scoping and offline flag on both paths", async () => {
      await expectHelpParity("app:includes:update", ["[SOURCE...]", "--no-network"]);
    }, 30_000);

    test("meta:setup representative validation failure matches on both paths", async () => {
      const source = await runSourceCli(["meta:setup", "--host-proxy=bad"]);
      const compiled = await runCompiledCli(["meta:setup", "--host-proxy=bad"]);

      expect(source.exitCode).toBe(2);
      expect(compiled.exitCode).toBe(source.exitCode);
      expect(compiled.stdout).toBe("");
      expect(normalizeOutput(compiled.stderr)).toContain(
        "Expected --host-proxy=bad to be one of: auto, none",
      );
    }, 30_000);

    test("meta:setup --format json emits the canonical setup envelope on both paths", async () => {
      const isolated = makeIsolatedEnv();
      const args = [
        "meta:setup",
        "--yes",
        "--skip-provider",
        "--skip-proxy",
        "--skip-install-ca",
        "--skip-shell-integration",
        "--skip-file-sync",
        "--format",
        "json",
      ];
      try {
        const source = await runSourceCli(args, { env: isolated.env });
        const compiled = await runCompiledCli(args, { env: isolated.env });

        expect(source.exitCode, `source stderr: ${source.stderr}`).toBe(0);
        expect(compiled.exitCode, `compiled stderr: ${compiled.stderr}`).toBe(0);
        const sourceEnvelope = normalizeJsonEnvelope(lastJsonLine(source.stdout));
        const compiledEnvelope = normalizeJsonEnvelope(lastJsonLine(compiled.stdout));
        expect(sourceEnvelope.command).toBe("meta:setup");
        expect(compiledEnvelope.command).toBe("meta:setup");
        expect(compiledEnvelope).toMatchObject({
          apiVersion: "v4",
          ok: true,
          result: { providerId: "lando", fileSyncStatus: "satisfied" },
        });
        expect(sourceEnvelope).toMatchObject({
          apiVersion: "v4",
          ok: true,
          result: { providerId: "lando", fileSyncStatus: "satisfied" },
        });
      } finally {
        isolated.cleanup();
      }
    }, 30_000);

    test("uninstall dry-run renders the same safety plan on both paths", async () => {
      const source = await runSourceCli(["uninstall", "--dry-run"]);
      const compiled = await runCompiledCli(["uninstall", "--dry-run"]);

      expect(source.exitCode, `source stderr: ${source.stderr}`).toBe(0);
      expect(compiled.exitCode, `compiled stderr: ${compiled.stderr}`).toBe(0);
      expect(normalizeOutput(compiled.stdout)).toBe(normalizeOutput(source.stdout));
      expect(compiled.stderr).toBe("");
    }, 30_000);

    test("meta:uninstall without --yes refuses destructively on both paths", async () => {
      const source = await runSourceCli(["meta:uninstall"]);
      const compiled = await runCompiledCli(["meta:uninstall"]);

      expect(source.exitCode).toBe(1);
      expect(compiled.exitCode).toBe(source.exitCode);
      expect(normalizeOutput(compiled.stdout)).toContain("uninstall refused");
      expect(normalizeOutput(compiled.stdout)).toBe(normalizeOutput(source.stdout));
    }, 30_000);

    test("meta:uninstall rejects unknown flags on both paths", async () => {
      const source = await runSourceCli(["meta:uninstall", "--definitely-not-an-uninstall-flag"]);
      const compiled = await runCompiledCli(["meta:uninstall", "--definitely-not-an-uninstall-flag"]);

      expect(source.exitCode).toBe(2);
      expect(compiled.exitCode).toBe(source.exitCode);
      expect(compiled.stdout).toBe("");
      expect(compiled.stderr).toContain("Nonexistent flag: --definitely-not-an-uninstall-flag");
    }, 30_000);

    test("setup top-level alias and meta:setup canonical id dispatch identically on each path", async () => {
      const sourceAlias = await runSourceCli(["setup", "--host-proxy=bad"]);
      const sourceCanonical = await runSourceCli(["meta:setup", "--host-proxy=bad"]);
      const compiledAlias = await runCompiledCli(["setup", "--host-proxy=bad"]);
      const compiledCanonical = await runCompiledCli(["meta:setup", "--host-proxy=bad"]);

      expect(sourceAlias.exitCode).toBe(sourceCanonical.exitCode);
      expect(normalizeOutput(sourceAlias.stdout)).toBe(normalizeOutput(sourceCanonical.stdout));
      expect(normalizeOutput(sourceAlias.stderr)).toBe(normalizeOutput(sourceCanonical.stderr));

      expect(compiledAlias.exitCode).toBe(compiledCanonical.exitCode);
      expect(normalizeOutput(compiledAlias.stdout)).toBe(normalizeOutput(compiledCanonical.stdout));
      expect(normalizeOutput(compiledAlias.stderr)).toBe(normalizeOutput(compiledCanonical.stderr));

      expect(compiledAlias.exitCode).toBe(sourceAlias.exitCode);
    }, 30_000);

    test("shellenv top-level alias and meta:shellenv canonical id print the same snippet on each path", async () => {
      const sourceAlias = await runSourceCli(["shellenv"]);
      const sourceCanonical = await runSourceCli(["meta:shellenv"]);
      const compiledAlias = await runCompiledCli(["shellenv"]);
      const compiledCanonical = await runCompiledCli(["meta:shellenv"]);

      expect(sourceAlias.exitCode, `source stderr: ${sourceAlias.stderr}`).toBe(0);
      expect(compiledAlias.exitCode, `compiled stderr: ${compiledAlias.stderr}`).toBe(0);
      expect(normalizeOutput(sourceAlias.stdout)).toBe(normalizeOutput(sourceCanonical.stdout));
      expect(normalizeOutput(compiledAlias.stdout)).toBe(normalizeOutput(compiledCanonical.stdout));
      expect(normalizeOutput(compiledAlias.stdout)).toBe(normalizeOutput(sourceAlias.stdout));
    }, 30_000);

    test("update top-level alias and meta:update canonical id reject invalid channels on both paths", async () => {
      const sourceAlias = await runSourceCli(["update", "--channel=bogus", "--dry-run"]);
      const sourceCanonical = await runSourceCli(["meta:update", "--channel=bogus", "--dry-run"]);
      const compiledAlias = await runCompiledCli(["update", "--channel=bogus", "--dry-run"]);
      const compiledCanonical = await runCompiledCli(["meta:update", "--channel=bogus", "--dry-run"]);

      expect(sourceAlias.exitCode).toBe(2);
      expect(sourceCanonical.exitCode).toBe(sourceAlias.exitCode);
      expect(compiledAlias.exitCode).toBe(sourceAlias.exitCode);
      expect(compiledCanonical.exitCode).toBe(sourceAlias.exitCode);
      expect(normalizeOutput(sourceAlias.stderr)).toContain("Expected --channel=bogus to be one of");
      expect(normalizeOutput(sourceCanonical.stderr)).toBe(normalizeOutput(sourceAlias.stderr));
      expect(normalizeOutput(compiledAlias.stderr)).toContain("Expected --channel=bogus to be one of");
      expect(normalizeOutput(compiledCanonical.stderr)).toBe(normalizeOutput(compiledAlias.stderr));
    }, 30_000);

    test("uninstall top-level alias and meta:uninstall canonical id render the same dry-run plan on each path", async () => {
      const isolated = makeIsolatedEnv();
      try {
        const sourceAlias = await runSourceCli(["uninstall", "--dry-run"], { env: isolated.env });
        const sourceCanonical = await runSourceCli(["meta:uninstall", "--dry-run"], { env: isolated.env });
        const compiledAlias = await runCompiledCli(["uninstall", "--dry-run"], { env: isolated.env });
        const compiledCanonical = await runCompiledCli(["meta:uninstall", "--dry-run"], {
          env: isolated.env,
        });

        expect(sourceAlias.exitCode, `source stderr: ${sourceAlias.stderr}`).toBe(0);
        expect(compiledAlias.exitCode, `compiled stderr: ${compiledAlias.stderr}`).toBe(0);
        expect(normalizeOutput(sourceAlias.stdout)).toBe(normalizeOutput(sourceCanonical.stdout));
        expect(normalizeOutput(compiledAlias.stdout)).toBe(normalizeOutput(compiledCanonical.stdout));
        expect(normalizeOutput(compiledAlias.stdout)).toBe(normalizeOutput(sourceAlias.stdout));
      } finally {
        isolated.cleanup();
      }
    }, 30_000);

    test("uninstall --purge dry-run previews owned data and cache roots at parity on both paths", async () => {
      const isolated = makeIsolatedEnv();
      try {
        const source = await runSourceCli(["uninstall", "--dry-run", "--purge"], { env: isolated.env });
        const compiled = await runCompiledCli(["uninstall", "--dry-run", "--purge"], { env: isolated.env });

        expect(source.exitCode, `source stderr: ${source.stderr}`).toBe(0);
        expect(compiled.exitCode).toBe(source.exitCode);
        expect(source.stdout).toContain("mode: purge");
        expect(normalizeOutput(compiled.stdout)).toBe(normalizeOutput(source.stdout));
      } finally {
        isolated.cleanup();
      }
    }, 30_000);

    test("meta:uninstall rejects --yes=false / --purge=false (boolean flags take no value) on both paths", async () => {
      const isolated = makeIsolatedEnv();
      try {
        for (const malformed of [
          ["meta:uninstall", "--yes=false"],
          ["meta:uninstall", "--purge=false"],
          ["uninstall", "--dry-run=false"],
        ]) {
          const source = await runSourceCli(malformed, { env: isolated.env });
          const compiled = await runCompiledCli(malformed, { env: isolated.env });

          expect(source.exitCode, `${malformed.join(" ")} source stderr: ${source.stderr}`).toBe(2);
          expect(compiled.exitCode, `${malformed.join(" ")}`).toBe(source.exitCode);
          expect(compiled.stdout).toBe("");
          expect(compiled.stderr).toContain("Unexpected argument: false");
        }
      } finally {
        isolated.cleanup();
      }
    }, 30_000);

    test("uninstall rejects extra positionals and tokens after `--` on both paths", async () => {
      const isolated = makeIsolatedEnv();
      try {
        for (const malformed of [
          ["uninstall", "--dry-run", "extra-positional"],
          ["uninstall", "--dry-run", "--", "--bad"],
        ]) {
          const source = await runSourceCli(malformed, { env: isolated.env });
          const compiled = await runCompiledCli(malformed, { env: isolated.env });

          expect(source.exitCode, `${malformed.join(" ")} source stderr: ${source.stderr}`).toBe(2);
          expect(compiled.exitCode, `${malformed.join(" ")}`).toBe(source.exitCode);
          expect(compiled.stdout).toBe("");
          expect(compiled.stderr).toContain("Unexpected argument:");
        }
      } finally {
        isolated.cleanup();
      }
    }, 30_000);

    test("meta:setup rejects a value flag with no value (bare or followed by another flag) on both paths", async () => {
      for (const malformed of [
        ["meta:setup", "--provider"],
        ["meta:setup", "--provider", "--yes"],
        ["meta:setup", "--host-proxy"],
      ]) {
        const source = await runSourceCli(malformed);
        const compiled = await runCompiledCli(malformed);

        expect(source.exitCode, `${malformed.join(" ")} source stderr: ${source.stderr}`).toBe(2);
        expect(compiled.exitCode, `${malformed.join(" ")}`).toBe(source.exitCode);
        expect(compiled.stdout).toBe("");
        expect(compiled.stderr).toContain("expects");
      }
    }, 30_000);

    test("meta:shellenv rejects tokens after `--` on both paths", async () => {
      const source = await runSourceCli(["meta:shellenv", "--", "--bad"]);
      const compiled = await runCompiledCli(["meta:shellenv", "--", "--bad"]);

      expect(source.exitCode).toBe(2);
      expect(compiled.exitCode).toBe(source.exitCode);
      expect(compiled.stdout).toBe("");
      expect(compiled.stderr).toContain("Unexpected argument: --bad");
    }, 30_000);

    test("meta:plugin:new rejects invalid template values on both paths", async () => {
      const args = [
        "meta:plugin:new",
        "@acme/lando-plugin-bad",
        "./bad",
        "--template=nope",
        "--cspace=acme",
        "--description=Bad",
        "--no-interactive",
      ];
      const source = await runSourceCli(args);
      const compiled = await runCompiledCli(args);

      expect(source.exitCode).toBe(2);
      expect(compiled.exitCode).toBe(source.exitCode);
      expect(compiled.stdout).toBe("");
      expect(compiled.stderr).toContain("Expected --template=nope to be one of:");
    }, 30_000);

    test("meta:plugin:test forwards post-dash help flags to Bun on both paths", async () => {
      const fixture = makePluginTestFixture();
      try {
        const source = await runSourceCli(["meta:plugin:test", "--renderer=plain", "--", "--help"], {
          cwd: fixture.root,
        });
        const compiled = await runCompiledCli(["meta:plugin:test", "--renderer=plain", "--", "--help"], {
          cwd: fixture.root,
        });

        expect(source.exitCode, `source stderr: ${source.stderr}`).toBe(0);
        expect(compiled.exitCode, `compiled stderr: ${compiled.stderr}`).toBe(source.exitCode);
        expect(source.stdout).toContain("plugin-test: @acme/lando-plugin-parity");
        expect(compiled.stdout).toContain("plugin-test: @acme/lando-plugin-parity");
        expect(compiled.stdout).not.toContain("USAGE\n  $ lando meta:plugin:test");
      } finally {
        fixture.cleanup();
      }
    }, 30_000);

    test("meta:plugin:build mixed-tree refusal dispatches on both paths", async () => {
      const fixture = makePluginBuildMixedTreeFixture();
      try {
        const source = await runSourceCli(["meta:plugin:build", "--renderer=json"], { cwd: fixture.root });
        const compiled = await runCompiledCli(["meta:plugin:build", "--renderer=json"], {
          cwd: fixture.root,
        });

        expect(source.exitCode).toBe(1);
        expect(compiled.exitCode).toBe(source.exitCode);
        const sourceEnvelope = normalizeJsonEnvelope(lastJsonLine(source.stdout || source.stderr));
        const compiledEnvelope = normalizeJsonEnvelope(lastJsonLine(compiled.stdout || compiled.stderr));
        expect(compiledEnvelope).toEqual(sourceEnvelope);
        expect(sourceEnvelope.code).toBe("PluginBuildMixedTreeError");
      } finally {
        fixture.cleanup();
      }
    }, 30_000);

    test("app:start with no Landofile: both fail with LandofileNotFoundError, not NotImplementedError", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "lando-parity-nostart-"));
      try {
        const source = await runSourceCli(["app:start", "--renderer=json"], { cwd });
        const compiled = await runCompiledCli(["app:start", "--renderer=json"], { cwd });
        expect(source.exitCode).toBe(1);
        expect(compiled.exitCode).toBe(source.exitCode);
        const sourceEnvelope = normalizeJsonEnvelope(lastJsonLine(source.stdout || source.stderr));
        const compiledEnvelope = normalizeJsonEnvelope(lastJsonLine(compiled.stdout || compiled.stderr));
        expect(compiledEnvelope).toEqual(sourceEnvelope);
        expect(sourceEnvelope.code).toBe("LandofileNotFoundError");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }, 30_000);
  });

  describe("meta:mcp dispatches identically on both paths", () => {
    test("mcp --list projects the same effective catalog envelope on both paths", async () => {
      const source = await runSourceCli(["mcp", "--list", "--format=json"]);
      const compiled = await runCompiledCli(["mcp", "--list", "--format=json"]);
      expect(source.exitCode, `source stderr: ${source.stderr}`).toBe(0);
      expect(compiled.exitCode, `compiled stderr: ${compiled.stderr}`).toBe(0);
      expect(compiled.stderr).not.toContain("NotImplementedError");
      const sourceEnvelope = normalizeJsonEnvelope(lastJsonLine(source.stdout));
      const compiledEnvelope = normalizeJsonEnvelope(lastJsonLine(compiled.stdout));
      expect(compiledEnvelope).toEqual(sourceEnvelope);
      expect(compiledEnvelope.command).toBe("meta:mcp");
    }, 30_000);

    test("mcp serve without stdin closes on EOF and exits 0 with no protocol frame on both paths", async () => {
      const source = await runSourceCli(["mcp"]);
      const compiled = await runCompiledCli(["mcp"]);
      expect(source.exitCode, `source stderr: ${source.stderr}`).toBe(0);
      expect(compiled.exitCode, `compiled stderr: ${compiled.stderr}`).toBe(0);
      expect(compiled.stderr).not.toContain("NotImplementedError");
      expect(source.stdout.trim()).toBe("");
      expect(compiled.stdout.trim()).toBe("");
    }, 30_000);

    test("mcp --list rejects an unknown --allow id identically on both paths", async () => {
      const source = await runSourceCli(["mcp", "--list", "--allow", "bogus:id", "--format=json"]);
      const compiled = await runCompiledCli(["mcp", "--list", "--allow", "bogus:id", "--format=json"]);
      expect(source.exitCode).not.toBe(0);
      expect(compiled.exitCode).toBe(source.exitCode);
      const sourceEnvelope = normalizeJsonEnvelope(lastJsonLine(source.stdout || source.stderr));
      const compiledEnvelope = normalizeJsonEnvelope(lastJsonLine(compiled.stdout || compiled.stderr));
      expect(compiledEnvelope).toEqual(sourceEnvelope);
      expect(sourceEnvelope.code).toBe("McpToolInputError");
    }, 30_000);
  });

  describe("deferred canonical ids defer identically on both paths", () => {
    const probeIds = ["meta:recipes:list", "meta:events:follow", "meta:plugin:login"] as const;
    for (const id of probeIds) {
      test(`${id}: both paths emit NotImplementedError with matching tagged fields`, async () => {
        const source = await runSourceCli([id, "--renderer=json"]);
        const compiled = await runCompiledCli([id, "--renderer=json"]);
        expect(source.exitCode).toBe(1);
        expect(compiled.exitCode).toBe(source.exitCode);
        const sourceEnvelope = normalizeJsonEnvelope(lastJsonLine(source.stdout || source.stderr));
        const compiledEnvelope = normalizeJsonEnvelope(lastJsonLine(compiled.stdout || compiled.stderr));
        expect(compiledEnvelope).toEqual(sourceEnvelope);
        expect(sourceEnvelope.code).toBe("NotImplementedError");
        expect(sourceEnvelope.commandId).toBe(id);
      }, 30_000);
    }

    test("plain renderer: a deferred id reports the same tagged error code on both paths", async () => {
      const source = await runSourceCli(["meta:recipes:list"]);
      const compiled = await runCompiledCli(["meta:recipes:list"]);
      expect(compiled.exitCode).toBe(source.exitCode);
      expect(errorCodeFromStderr(source.stderr)).toBe("NotImplementedError");
      expect(errorCodeFromStderr(compiled.stderr)).toBe("NotImplementedError");
    }, 30_000);
  });

  describe("plugin authoring commands dispatch at full parity", () => {
    test("new: scaffolds identically and writes nothing under userDataRoot", async () => {
      const isolated = makeIsolatedEnv();
      const sourceDest = mkdtempSync(join(tmpdir(), "lando-parity-new-src-"));
      const compiledDest = mkdtempSync(join(tmpdir(), "lando-parity-new-cmp-"));
      const newArgs = (dest: string): ReadonlyArray<string> => [
        "meta:plugin:new",
        "@acme/lando-plugin-parity-new",
        join(dest, "p"),
        "--template=bare",
        "--cspace=acme",
        "--description=Demo",
        "--no-interactive",
      ];
      try {
        const source = await runSourceCli(newArgs(sourceDest), { env: isolated.env });
        const compiled = await runCompiledCli(newArgs(compiledDest), { env: isolated.env });
        expect(source.exitCode, `source stderr: ${source.stderr}`).toBe(0);
        expect(compiled.exitCode, `compiled stderr: ${compiled.stderr}`).toBe(source.exitCode);
        expect(normalizeOutput(compiled.stdout)).toBe(normalizeOutput(source.stdout));
        expect(listTree(join(envPath(isolated.env, "LANDO_USER_DATA_ROOT"), "plugins"))).toEqual([]);
      } finally {
        rmSync(sourceDest, { recursive: true, force: true });
        rmSync(compiledDest, { recursive: true, force: true });
        isolated.cleanup();
      }
    }, 30_000);

    test("new: rejects an unknown flag on both paths", async () => {
      await expectUnknownFlagParity(
        ["meta:plugin:new", "@acme/lando-plugin-x", "./x", "--bogus", "--no-interactive"],
        "--bogus",
      );
    }, 30_000);

    test("new: prints command help on both paths", async () => {
      await expectHelpParity("meta:plugin:new", ["Scaffold a new plugin", "USAGE"]);
    }, 30_000);

    test("new: invalid --template value is rejected with exit 2 on both paths", async () => {
      const args = [
        "meta:plugin:new",
        "@acme/lando-plugin-x",
        "./x",
        "--template=nope",
        "--cspace=acme",
        "--description=Demo",
        "--no-interactive",
      ];
      const source = await runSourceCli(args);
      const compiled = await runCompiledCli(args);
      expect(source.exitCode).toBe(2);
      expect(compiled.exitCode).toBe(source.exitCode);
      expect(compiled.stdout).toBe("");
      expect(source.stderr).toContain("Expected --template=nope to be one of:");
      expect(compiled.stderr).toContain("Expected --template=nope to be one of:");
    }, 30_000);

    test("new: non-interactive missing input fails identically under renderer=json", async () => {
      await expectJsonEnvelopeParity(["meta:plugin:new", "--no-interactive"], "NotImplementedError");
    }, 30_000);

    test("new: non-TTY default missing input fails identically under renderer=json", async () => {
      await expectJsonEnvelopeParity(["meta:plugin:new"], "NotImplementedError");
    }, 30_000);

    test("test: rejects an unknown flag before `--` on both paths", async () => {
      await expectUnknownFlagParity(["meta:plugin:test", "--bogus"], "--bogus");
    }, 30_000);

    test("test: prints command help on both paths", async () => {
      await expectHelpParity("meta:plugin:test", ["Run the current plugin", "USAGE"]);
    }, 30_000);

    test("test: no plugin root fails identically under renderer=json", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "lando-parity-test-noroot-"));
      try {
        await expectJsonEnvelopeParity(["meta:plugin:test"], "PluginManifestError", { cwd });
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }, 30_000);

    test("test: runs the plugin suite identically (positional target)", async () => {
      const fixture = makePluginTestFixture();
      try {
        const args = ["meta:plugin:test", "test/plugin.test.ts", "--renderer=plain"];
        const source = await runSourceCli(args, { cwd: fixture.root });
        const compiled = await runCompiledCli(args, { cwd: fixture.root });
        expect(source.exitCode, `source stderr: ${source.stderr}`).toBe(0);
        expect(compiled.exitCode, `compiled stderr: ${compiled.stderr}`).toBe(source.exitCode);
        expect(source.stdout).toContain("plugin-test: @acme/lando-plugin-parity");
        expect(compiled.stdout).toContain("plugin-test: @acme/lando-plugin-parity");
      } finally {
        fixture.cleanup();
      }
    }, 60_000);

    test("build: rejects an unknown flag on both paths", async () => {
      await expectUnknownFlagParity(["meta:plugin:build", "--bogus"], "--bogus");
    }, 30_000);

    test("build: prints command help on both paths", async () => {
      await expectHelpParity("meta:plugin:build", ["Build the current plugin", "USAGE"]);
    }, 30_000);

    test("build: no plugin root fails identically under renderer=json", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "lando-parity-build-noroot-"));
      try {
        await expectJsonEnvelopeParity(["meta:plugin:build"], "PluginManifestError", { cwd });
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }, 30_000);

    test("build: builds a valid plugin identically and writes nothing under userDataRoot", async () => {
      const fixture = makePluginPackageFixture(
        "@acme/lando-plugin-build-parity",
        "lando-parity-plugin-build-ok-",
      );
      const isolated = makeIsolatedEnv();
      try {
        const source = await runSourceCli(["meta:plugin:build", "--renderer=plain"], {
          cwd: fixture.root,
          env: isolated.env,
        });
        rmSync(join(fixture.root, "dist"), { recursive: true, force: true });
        const compiled = await runCompiledCli(["meta:plugin:build", "--renderer=plain"], {
          cwd: fixture.root,
          env: isolated.env,
        });
        expect(source.exitCode, `source stderr: ${source.stderr}`).toBe(0);
        expect(compiled.exitCode, `compiled stderr: ${compiled.stderr}`).toBe(source.exitCode);
        expect(normalizeOutput(compiled.stdout)).toBe(normalizeOutput(source.stdout));
        expect(listTree(join(envPath(isolated.env, "LANDO_USER_DATA_ROOT"), "plugins"))).toEqual([]);
      } finally {
        fixture.cleanup();
        isolated.cleanup();
      }
    }, 120_000);

    test("link: links a plugin identically and writes only under the plugins root", async () => {
      const sourceFixture = makePluginPackageFixture(
        "@acme/lando-plugin-link-parity",
        "lando-parity-plugin-link-src-",
      );
      const compiledFixture = makePluginPackageFixture(
        "@acme/lando-plugin-link-parity",
        "lando-parity-plugin-link-cmp-",
      );
      const sourceEnv = makeIsolatedEnv();
      const compiledEnv = makeIsolatedEnv();
      try {
        const source = await runSourceCli(["meta:plugin:link"], {
          cwd: sourceFixture.root,
          env: sourceEnv.env,
        });
        const compiled = await runCompiledCli(["meta:plugin:link"], {
          cwd: compiledFixture.root,
          env: compiledEnv.env,
        });
        expect(source.exitCode, `source stderr: ${source.stderr}`).toBe(0);
        expect(compiled.exitCode, `compiled stderr: ${compiled.stderr}`).toBe(source.exitCode);
        expect(normalizeOutput(compiled.stdout)).toBe(normalizeOutput(source.stdout));
        const created = listTree(envPath(compiledEnv.env, "LANDO_USER_DATA_ROOT"));
        expect(created.length).toBeGreaterThan(0);
        expect(pathsOutsidePrefixes(created, ["plugins"])).toEqual([]);
      } finally {
        sourceFixture.cleanup();
        compiledFixture.cleanup();
        sourceEnv.cleanup();
        compiledEnv.cleanup();
      }
    }, 30_000);

    test("link: rejects an unknown flag on both paths", async () => {
      await expectUnknownFlagParity(["meta:plugin:link", "--bogus"], "--bogus");
    }, 30_000);

    test("link: prints command help on both paths", async () => {
      await expectHelpParity("meta:plugin:link", ["Symlink the current plugin", "USAGE"]);
    }, 30_000);

    test("unlink: links then unlinks identically and writes only under the plugins root", async () => {
      const sourceFixture = makePluginPackageFixture(
        "@acme/lando-plugin-unlink-parity",
        "lando-parity-plugin-unlink-src-",
      );
      const compiledFixture = makePluginPackageFixture(
        "@acme/lando-plugin-unlink-parity",
        "lando-parity-plugin-unlink-cmp-",
      );
      const sourceEnv = makeIsolatedEnv();
      const compiledEnv = makeIsolatedEnv();
      try {
        await runSourceCli(["meta:plugin:link"], { cwd: sourceFixture.root, env: sourceEnv.env });
        await runCompiledCli(["meta:plugin:link"], { cwd: compiledFixture.root, env: compiledEnv.env });
        const source = await runSourceCli(["meta:plugin:unlink", "@acme/lando-plugin-unlink-parity"], {
          cwd: sourceFixture.root,
          env: sourceEnv.env,
        });
        const compiled = await runCompiledCli(["meta:plugin:unlink", "@acme/lando-plugin-unlink-parity"], {
          cwd: compiledFixture.root,
          env: compiledEnv.env,
        });
        expect(source.exitCode, `source stderr: ${source.stderr}`).toBe(0);
        expect(compiled.exitCode, `compiled stderr: ${compiled.stderr}`).toBe(source.exitCode);
        expect(normalizeOutput(compiled.stdout)).toBe(normalizeOutput(source.stdout));
        expect(
          pathsOutsidePrefixes(listTree(envPath(compiledEnv.env, "LANDO_USER_DATA_ROOT")), ["plugins"]),
        ).toEqual([]);
      } finally {
        sourceFixture.cleanup();
        compiledFixture.cleanup();
        sourceEnv.cleanup();
        compiledEnv.cleanup();
      }
    }, 30_000);

    test("unlink: rejects an unknown flag on both paths", async () => {
      await expectUnknownFlagParity(["meta:plugin:unlink", "somename", "--bogus"], "--bogus");
    }, 30_000);

    test("unlink: prints command help on both paths", async () => {
      await expectHelpParity("meta:plugin:unlink", ["Remove a previously linked plugin", "USAGE"]);
    }, 30_000);

    test("unlink: missing required name fails with exit 2 on both paths", async () => {
      const source = await runSourceCli(["meta:plugin:unlink"]);
      const compiled = await runCompiledCli(["meta:plugin:unlink"]);
      expect(source.exitCode).toBe(2);
      expect(compiled.exitCode).toBe(source.exitCode);
      expect(compiled.stdout).toBe("");
      expect(source.stderr).toContain("Missing 1 required arg");
      expect(compiled.stderr).toContain("Missing 1 required arg");
    }, 30_000);

    test("unlink: not-linked failure matches identically under renderer=json", async () => {
      const isolated = makeIsolatedEnv();
      try {
        await expectJsonEnvelopeParity(
          ["meta:plugin:unlink", "@acme/lando-plugin-not-linked"],
          "PluginUnlinkNotLinkedError",
          { env: isolated.env },
        );
      } finally {
        isolated.cleanup();
      }
    }, 30_000);

    test("publish: dry-run renders identically and writes nothing under userDataRoot", async () => {
      const fixture = makePluginPublishFreshFixture();
      const isolated = makeIsolatedEnv();
      try {
        const args = ["meta:plugin:publish", "--dry-run", "--no-test", "--renderer=plain"];
        const source = await runSourceCli(args, { cwd: fixture.root, env: isolated.env });
        const compiled = await runCompiledCli(args, { cwd: fixture.root, env: isolated.env });
        expect(source.exitCode, `source stderr: ${source.stderr}`).toBe(0);
        expect(compiled.exitCode, `compiled stderr: ${compiled.stderr}`).toBe(source.exitCode);
        expect(normalizeOutput(compiled.stdout)).toBe(normalizeOutput(source.stdout));
        expect(source.stdout).toContain("dry-run");
        expect(listTree(join(envPath(isolated.env, "LANDO_USER_DATA_ROOT"), "plugins"))).toEqual([]);
      } finally {
        fixture.cleanup();
        isolated.cleanup();
      }
    }, 60_000);

    test("publish: rejects an unknown flag on both paths", async () => {
      await expectUnknownFlagParity(["meta:plugin:publish", "--bogus"], "--bogus");
    }, 30_000);

    test("publish: prints command help on both paths", async () => {
      await expectHelpParity("meta:plugin:publish", ["Publish the current plugin", "USAGE"]);
    }, 30_000);

    test("publish: missing auth fails identically under renderer=json (non-interactive)", async () => {
      const fixture = makePluginPublishFreshFixture();
      const isolated = makeIsolatedEnv();
      try {
        await expectJsonEnvelopeParity(
          ["meta:plugin:publish", "--no-test", "--no-interactive"],
          "PluginPublishAuthError",
          { cwd: fixture.root, env: isolated.env },
        );
      } finally {
        fixture.cleanup();
        isolated.cleanup();
      }
    }, 60_000);
  });

  describe("answer-source and interactivity resolution at parity", () => {
    test("apps:init: flag answers + --no-interactive scaffold identically", async () => {
      const isolated = makeIsolatedEnv();
      const sourceCwd = mkdtempSync(join(tmpdir(), "lando-parity-init-src-"));
      const compiledCwd = mkdtempSync(join(tmpdir(), "lando-parity-init-cmp-"));
      const args: ReadonlyArray<string> = [
        "apps:init",
        "--recipe=empty",
        "--name=parity-init-app",
        "--no-interactive",
      ];
      try {
        const source = await runSourceCli(args, { cwd: sourceCwd, env: isolated.env });
        const compiled = await runCompiledCli(args, { cwd: compiledCwd, env: isolated.env });
        expect(source.exitCode, `source stderr: ${source.stderr}`).toBe(0);
        expect(compiled.exitCode, `compiled stderr: ${compiled.stderr}`).toBe(source.exitCode);
        expect(normalizeOutput(compiled.stdout)).toBe(normalizeOutput(source.stdout));
        expect(readFileSync(join(sourceCwd, "parity-init-app", ".lando.yml"), "utf-8")).toBe(
          readFileSync(join(compiledCwd, "parity-init-app", ".lando.yml"), "utf-8"),
        );
      } finally {
        rmSync(sourceCwd, { recursive: true, force: true });
        rmSync(compiledCwd, { recursive: true, force: true });
        isolated.cleanup();
      }
    }, 30_000);

    test("apps:init: piped (non-TTY) stdin resolves the default recipe identically on both paths", async () => {
      const isolated = makeIsolatedEnv();
      const sourceCwd = mkdtempSync(join(tmpdir(), "lando-parity-init-stdin-src-"));
      const compiledCwd = mkdtempSync(join(tmpdir(), "lando-parity-init-stdin-cmp-"));
      // Piped stdin is non-TTY, so both paths resolve non-interactively to the
      // default recipe + slugified name — the scripted lines are never consumed.
      const stdin = "empty\nstdin-init-app\n";
      try {
        const source = await runSourceCli(["apps:init", "--name=piped-init-app"], {
          cwd: sourceCwd,
          env: isolated.env,
          stdin,
        });
        const compiled = await runCompiledCli(["apps:init", "--name=piped-init-app"], {
          cwd: compiledCwd,
          env: isolated.env,
          stdin,
        });
        expect(source.exitCode, `source stderr: ${source.stderr}`).toBe(0);
        expect(compiled.exitCode, `compiled stderr: ${compiled.stderr}`).toBe(source.exitCode);
        expect(normalizeOutput(compiled.stdout)).toBe(normalizeOutput(source.stdout));
      } finally {
        rmSync(sourceCwd, { recursive: true, force: true });
        rmSync(compiledCwd, { recursive: true, force: true });
        isolated.cleanup();
      }
    }, 30_000);

    test("meta:plugin:new: repeatable --answer flags resolve remaining values identically", async () => {
      const isolated = makeIsolatedEnv();
      const sourceDest = mkdtempSync(join(tmpdir(), "lando-parity-new-ans-src-"));
      const compiledDest = mkdtempSync(join(tmpdir(), "lando-parity-new-ans-cmp-"));
      const args = (dest: string): ReadonlyArray<string> => [
        "meta:plugin:new",
        "@acme/lando-plugin-parity-ans",
        join(dest, "p"),
        "--answer=template=bare",
        "--answer=cspace=acme",
        "--answer=description=Demo plugin",
        "--no-interactive",
      ];
      try {
        const source = await runSourceCli(args(sourceDest), { env: isolated.env });
        const compiled = await runCompiledCli(args(compiledDest), { env: isolated.env });
        expect(source.exitCode, `source stderr: ${source.stderr}`).toBe(0);
        expect(compiled.exitCode, `compiled stderr: ${compiled.stderr}`).toBe(source.exitCode);
        expect(normalizeOutput(compiled.stdout)).toBe(normalizeOutput(source.stdout));
        expect(readFileSync(join(sourceDest, "p", "plugin.yaml"), "utf-8")).toBe(
          readFileSync(join(compiledDest, "p", "plugin.yaml"), "utf-8"),
        );
      } finally {
        rmSync(sourceDest, { recursive: true, force: true });
        rmSync(compiledDest, { recursive: true, force: true });
        isolated.cleanup();
      }
    }, 30_000);

    test("meta:plugin:add --trust: missing spec rejects identically under renderer=json", async () => {
      const isolated = makeIsolatedEnv();
      try {
        await expectJsonEnvelopeParity(["meta:plugin:add", "--trust"], "NotImplementedError", {
          env: isolated.env,
        });
      } finally {
        isolated.cleanup();
      }
    }, 30_000);

    test("meta:plugin:add --trust: an invalid spec rejects identically on both paths", async () => {
      const isolated = makeIsolatedEnv();
      try {
        await expectJsonEnvelopeParity(
          ["meta:plugin:add", "git+https://example.com/x.git", "--trust"],
          "NotImplementedError",
          { env: isolated.env },
        );
      } finally {
        isolated.cleanup();
      }
    }, 30_000);
  });
});

afterAll(() => {
  /* no-op: the shared compiled binary is reused, never removed here. */
});
