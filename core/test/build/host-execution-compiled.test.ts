import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse, relative, resolve } from "node:path";
import * as Schema from "effect/Schema";
import { lastEnvelope } from "../cli/subprocess-support.ts";
import {
  expectHostDirectory as expectDirectory,
  hostDirectoryProbe,
  nativeHostDirectory,
  runCaptured,
  runHostShellPty,
} from "./fixtures/host-execution-process.ts";
// Native build lanes invoke this entry alone, so include the oracle regressions.
import "./host-execution-directory.test.ts";

const suppliedBinary = process.env.LANDO_TEST_COMPILED_CLI;
const windows = process.platform === "win32";
const toolingSchema = Schema.Struct({
  ok: Schema.Literal(true),
  result: Schema.Struct({ stdout: Schema.String, exitCode: Schema.Literal(0) }),
});

describe.skipIf(suppliedBinary === undefined)("supplied compiled host execution", () => {
  let root = "";
  let binary = "";
  let app = "";
  let launch = "";
  let env: NodeJS.ProcessEnv = {};
  const directories: Record<string, string> = {};

  const runCli = (args: readonly string[], overrides: NodeJS.ProcessEnv = {}) =>
    runCaptured([binary, ...args], launch, { ...env, ...overrides });

  const nativeDirectory = (rawCwd: string) => nativeHostDirectory(rawCwd, launch, env);

  beforeAll(async () => {
    // Do not use ensureCompiledCli: its missing-path fallback builds a binary.
    if (suppliedBinary === undefined || suppliedBinary === "")
      throw new Error("Supply a native binary with LANDO_TEST_COMPILED_CLI");
    const source = resolve(suppliedBinary);
    if (!(await stat(source)).isFile()) throw new Error(`Supplied compiled CLI is not a file: ${source}`);
    root = await mkdtemp(join(tmpdir(), "lando-host-compiled-"));
    app = join(root, "app");
    launch = join(app, "nested", "launch");
    const bin = join(root, "bin");
    await mkdir(bin);
    await mkdir(launch, { recursive: true });
    await mkdir(join(app, "physical", "child"), { recursive: true });
    await mkdir(join(app, "target"));
    await mkdir(join(app, ".lando", "scripts"), { recursive: true });
    binary = join(bin, windows ? "lando.exe" : "lando");
    await copyFile(source, binary);
    // Neither a parent shell's PWD nor any external Lando/Bun configuration owns this run.
    env = Object.fromEntries(
      Object.entries(process.env)
        .filter(([key]) => !/^(LANDO_|BUN_|PWD$)/i.test(key))
        .map(([key, value]) => [key.toUpperCase() === "PATH" ? "PATH" : key, value]),
    );
    Object.assign(env, {
      LANDO_USER_CONF_ROOT: join(root, "conf"),
      LANDO_USER_CACHE_ROOT: join(root, "cache"),
      LANDO_USER_DATA_ROOT: join(root, "data"),
      LANDO_SYSTEM_PLUGIN_ROOT: join(root, "system-plugins"),
      PWD: join(root, "stale-parent"),
      TERM: "dumb",
      NO_COLOR: "1",
    });
    await symlink(join(app, "physical", "child"), join(app, "link"), windows ? "junction" : "dir");
    for (const [path, marker] of [
      [app, "lexical-parent"],
      [join(app, "physical"), "physical-parent"],
      [join(app, "target"), "tool-target"],
      [launch, "launch-directory"],
    ] as const) {
      await writeFile(join(path, ".host-marker"), marker);
    }
    Object.assign(directories, {
      "host-inspect": join(app, "target"),
      // String concatenation deliberately preserves link/.. for the runtime boundary.
      "host-link-parent": `${app}/link/..`,
      "host-invalid": `${app}/missing-directory`,
      "host-pwd-explicit": join(app, "target"),
      "host-pwd-empty": join(app, "target"),
      ...(windows
        ? {
            "host-drive-relative": `${parse(app).root.slice(0, 2)}${relative(launch, join(app, "target"))}`,
            "host-case-env": join(app, "target"),
          }
        : {}),
    });
    const tooling = Object.fromEntries(
      Object.entries(directories).map(([name, dir]) => [
        name,
        {
          service: ":host",
          cmd: name === "host-case-env" ? `${hostDirectoryProbe}; host-path-proof` : hostDirectoryProbe,
          dir: dir.replaceAll("\\", "/"),
          ...(name === "host-pwd-explicit" ? { env: { PWD: "authored-pwd" } } : {}),
          ...(name === "host-pwd-empty" ? { env: { PWD: "" } } : {}),
          ...(name === "host-case-env"
            ? { env: { pWd: "mixed-case-pwd", pAtH: bin.replaceAll("\\", "/") } }
            : {}),
        },
      ]),
    );
    if (windows) await writeFile(join(bin, "host-path-proof.cmd"), "@echo PATH_OVERRIDE_WORKED\r\n");
    await writeFile(join(app, ".lando.yml"), Bun.YAML.stringify({ name: "host-compiled", tooling }, null, 2));
    await writeFile(
      join(app, ".lando/scripts/host-script.bun.sh"),
      `# ---\n# desc: Inspect native host execution\n# ---\n${hostDirectoryProbe}\n`,
    );
    const refresh = await runCli(["app:cache:refresh", "--format=json"]);
    expect(refresh.exitCode, refresh.stderr + refresh.stdout).toBe(0);
  }, 60_000);

  afterAll(async () => {
    if (root !== "") await rm(root, { recursive: true, force: true });
  });

  test.each(["host-inspect", "host-link-parent"])(
    "uses native directory identity and synthesized PWD for %s",
    async (name) => {
      // Given
      const raw = directories[name];
      if (raw === undefined) throw new Error(`Missing fixture directory for ${name}`);
      const expected = await nativeDirectory(raw);
      if (!windows && name === "host-link-parent") expect(expected.marker).toBe("physical-parent");
      // When
      const result = await runCli([name, "--format=json"]);
      // Then
      expect(result.exitCode, result.stderr + result.stdout).toBe(0);
      const envelope = Schema.decodeUnknownSync(toolingSchema)(lastEnvelope(result.stdout));
      await expectDirectory(envelope.result.stdout, expected);
    },
    75_000,
  );

  test("runs .bun.sh at the app root without host Bun on PATH", async () => {
    // Given
    const expected = await nativeDirectory(app);
    // When
    const result = await runCli(["host-script", "--format=json"], { PATH: join(root, "bin") });
    // Then
    expect(result.exitCode, result.stderr + result.stdout).toBe(0);
    await expectDirectory(
      Schema.decodeUnknownSync(toolingSchema)(lastEnvelope(result.stdout)).result.stdout,
      expected,
    );
  }, 75_000);

  test.each([
    ["host-pwd-explicit", "authored-pwd"],
    ["host-pwd-empty", ""],
  ])(
    "preserves authored PWD for %s without changing the directory",
    async (name, pwd) => {
      // Given
      const expected = await nativeDirectory(join(app, "target"));
      // When
      const result = await runCli([name, "--format=json"]);
      // Then
      expect(result.exitCode, result.stderr + result.stdout).toBe(0);
      await expectDirectory(
        Schema.decodeUnknownSync(toolingSchema)(lastEnvelope(result.stdout)).result.stdout,
        expected,
        pwd,
      );
    },
    75_000,
  );

  test("reports a typed invalid-cwd failure with cwd context and remediation", async () => {
    // Given / When
    const result = await runCli(["host-invalid", "--format=json"]);
    // Then
    expect(result.exitCode).not.toBe(0);
    const envelope = lastEnvelope(result.stdout);
    expect(envelope.ok).toBe(false);
    const error = Schema.decodeUnknownSync(
      Schema.Struct({ _tag: Schema.String, remediation: Schema.String }),
    )(envelope.error);
    expect(error._tag).toMatch(/^(Shell|Tooling)ExecError$/);
    expect(error.remediation).toMatch(/\S/);
    expect(JSON.stringify(envelope.error)).toContain("missing-directory");
  }, 75_000);

  // Bun's terminal spawn is POSIX-only; the OpenTUI Windows harness uses Git winpty,
  // not native ConPTY. Native interactive Windows coverage needs a separate harness.
  test.skipIf(windows)(
    "executes interactive shell output through a real PTY from an app subdirectory",
    async () => {
      // Given
      const expected = await nativeDirectory(app);
      // When
      const output = await runHostShellPty(binary, launch, env);
      // Then
      await expectDirectory(output, expected);
    },
    75_000,
  );

  test.skipIf(!windows)(
    "honors native case-insensitive PWD and PATH overrides",
    async () => {
      // Given
      const expected = await nativeDirectory(join(app, "target"));
      // When
      const result = await runCli(["host-case-env", "--format=json"]);
      // Then
      expect(result.exitCode, result.stderr + result.stdout).toBe(0);
      const output = Schema.decodeUnknownSync(toolingSchema)(lastEnvelope(result.stdout)).result.stdout;
      await expectDirectory(output, expected, "mixed-case-pwd");
      expect(output.split(/\r?\n/)).toContain("PATH_OVERRIDE_WORKED");
    },
    75_000,
  );

  test.skipIf(!windows)(
    "matches a native child for a drive-relative requested cwd",
    async () => {
      // Given
      const raw = directories["host-drive-relative"];
      if (raw === undefined) throw new Error("Missing drive-relative fixture");
      const expected = await nativeDirectory(raw);
      // When
      const result = await runCli(["host-drive-relative", "--format=json"]);
      // Then
      expect(result.exitCode, result.stderr + result.stdout).toBe(0);
      await expectDirectory(
        Schema.decodeUnknownSync(toolingSchema)(lastEnvelope(result.stdout)).result.stdout,
        expected,
      );
    },
    75_000,
  );
  // UNC execution needs an actual native share; it is not simulated by this fixture.
});
