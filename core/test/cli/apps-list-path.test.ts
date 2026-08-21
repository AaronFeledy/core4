import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appsListPathFromInput } from "../../src/cli/command-specs/apps/list.ts";
import { appliedPlansDirectory } from "../../src/cli/commands/list.ts";
import { appsListPathFromArgv } from "../../src/cli/dispatch-apps.ts";
import { MalformedCliFlagValueError } from "../../src/cli/flag-value-validation.ts";
import { ensureCompiledCli } from "../_support/compiled-cli.ts";

const isLinuxX64 = process.platform === "linux" && process.arch === "x64";

describe("apps:list --path extraction seam", () => {
  test("appsListPathFromArgv reads the space form", () => {
    expect(appsListPathFromArgv(["--path", "demo"])).toBe("demo");
  });

  test("appsListPathFromArgv reads the equals form", () => {
    expect(appsListPathFromArgv(["--path=demo"])).toBe("demo");
  });

  test("appsListPathFromArgv is undefined when the flag is absent", () => {
    expect(appsListPathFromArgv([])).toBeUndefined();
  });

  test("appsListPathFromArgv rejects a valueless --path via the shared validator", () => {
    expect(() => appsListPathFromArgv(["--path"])).toThrow(MalformedCliFlagValueError);
  });

  test("appsListPathFromInput is the shared native extractor", () => {
    expect(appsListPathFromInput({ flags: { path: "demo" } })).toBe("demo");
    expect(appsListPathFromInput({ flags: {} })).toBeUndefined();
    expect(appsListPathFromInput(undefined)).toBeUndefined();
  });
});

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface AppsListResult {
  readonly apps: ReadonlyArray<{ readonly appName: string; readonly appRoot: string }>;
}

const runProcess = async (cmd: ReadonlyArray<string>, env: Record<string, string>): Promise<RunResult> => {
  const proc = Bun.spawn({ cmd: [...cmd], env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

const appNames = (result: RunResult): ReadonlyArray<string> => {
  const envelope = JSON.parse(result.stdout) as { readonly ok?: boolean; readonly result?: AppsListResult };
  expect(envelope.ok).toBe(true);
  return (envelope.result?.apps ?? []).map((app) => app.appName);
};

const makePlan = (id: string, root: string, services: ReadonlyArray<string>) => ({
  version: 1,
  data: {
    id,
    name: id,
    slug: id,
    root,
    provider: "lando",
    services: Object.fromEntries(
      services.map((s) => [s, { name: s, type: "lando.app", primary: false, env: {} }]),
    ),
  },
});

// The compiled binary is what users actually run; drive it against seeded,
// isolated LANDO_USER_* roots so `apps:list --path` filtering is deterministic
// and never touches host state.
describe.skipIf(!isLinuxX64)("apps:list --path on the compiled binary", () => {
  let compiledBinary: string;
  let root: string;
  let env: Record<string, string>;

  beforeAll(async () => {
    compiledBinary = await ensureCompiledCli();
    root = await mkdtemp(join(tmpdir(), "lando-apps-list-path-"));
    const appsDir = appliedPlansDirectory(join(root, "data"));
    await mkdir(appsDir, { recursive: true });
    await mkdir(join(root, "cache"), { recursive: true });
    await mkdir(join(root, "conf"), { recursive: true });
    await writeFile(
      join(appsDir, "alpha.json"),
      JSON.stringify(makePlan("alpha", "/srv/filter-alpha", ["appserver"])),
    );
    await writeFile(
      join(appsDir, "bravo.json"),
      JSON.stringify(makePlan("bravo", "/srv/filter-bravo", ["db", "web"])),
    );

    env = {
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
  }, 240_000);

  afterAll(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  test("filters via the apps:list command", async () => {
    const result = await runProcess(
      [compiledBinary, "apps:list", "--path", "filter-alpha", "--format", "json"],
      env,
    );
    expect(result.exitCode).toBe(0);
    expect(appNames(result)).toEqual(["alpha"]);
  });

  test("filters via the top-level `list` alias", async () => {
    const result = await runProcess(
      [compiledBinary, "list", "--path", "filter-alpha", "--format", "json"],
      env,
    );
    expect(result.exitCode).toBe(0);
    expect(appNames(result)).toEqual(["alpha"]);
  });

  test("filters via the equals form", async () => {
    const result = await runProcess(
      [compiledBinary, "apps:list", "--path=filter-bravo", "--format", "json"],
      env,
    );
    expect(result.exitCode).toBe(0);
    expect(appNames(result)).toEqual(["bravo"]);
  });

  test("returns every app when --path is omitted", async () => {
    const result = await runProcess([compiledBinary, "apps:list", "--format", "json"], env);
    expect(result.exitCode).toBe(0);
    expect(appNames(result)).toEqual(["alpha", "bravo"]);
  });
});
