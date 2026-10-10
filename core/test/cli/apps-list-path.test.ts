import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { Effect, Layer } from "effect";

import { ConfigService } from "@lando/sdk/services";

import { appsListPathFromInput } from "../../src/cli/command-specs/apps/list.ts";
import { appliedPlansDirectory, listServices } from "../../src/cli/commands/list.ts";
import { compiledCommandInputFromArgv } from "../../src/cli/compiled-input.ts";
import { MalformedCliFlagValueError } from "../../src/cli/flag-value-validation.ts";
import { ensureCompiledCli } from "../_support/compiled-cli.ts";
import { withCwd, withEnvVar } from "../_support/temp-cwd.ts";

const isLinuxX64 = process.platform === "linux" && process.arch === "x64";

describe("apps:list --path extraction seam", () => {
  test("appsListPathFromInput reads the space form", () => {
    expect(appsListPathFromInput(compiledCommandInputFromArgv("apps:list", ["--path", "demo"]))).toBe("demo");
  });

  test("appsListPathFromInput reads the equals form", () => {
    expect(appsListPathFromInput(compiledCommandInputFromArgv("apps:list", ["--path=demo"]))).toBe("demo");
  });

  test("appsListPathFromInput is undefined when the flag is absent", () => {
    expect(appsListPathFromInput(compiledCommandInputFromArgv("apps:list", []))).toBeUndefined();
  });

  test("appsListPathFromInput rejects a valueless --path via the shared validator", () => {
    expect(() => appsListPathFromInput(compiledCommandInputFromArgv("apps:list", ["--path"]))).toThrow(
      MalformedCliFlagValueError,
    );
  });

  test("appsListPathFromInput is the shared native extractor", () => {
    expect(appsListPathFromInput({ flags: { path: "demo" } })).toBe("demo");
    expect(appsListPathFromInput({ flags: {} })).toBeUndefined();
    expect(appsListPathFromInput(undefined)).toBeUndefined();
  });
});

const noDiscover = async () => [];

const fakeConfigService = (dataRoot: string) =>
  Layer.succeed(
    ConfigService,
    ConfigService.of({
      get: <K extends string>(key: K) =>
        Effect.succeed(key === "userDataRoot" ? (dataRoot as never) : (undefined as never)),
      getEffective: () => Effect.succeed({} as never),
    } as never),
  );

const writeAppliedPlan = async (dataRoot: string, id: string, root: string): Promise<void> => {
  const dir = appliedPlansDirectory(dataRoot);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${id}.json`),
    `${JSON.stringify(
      {
        version: 1,
        data: {
          id,
          name: id,
          slug: id,
          root,
          provider: "lando",
          services: { appserver: { name: "appserver", type: "lando.app", primary: false, env: {} } },
        },
      },
      null,
      2,
    )}\n`,
  );
};

const listNames = async (
  dataRoot: string,
  cacheRoot: string,
  path: string,
  discoverContainers: (
    userDataRoot: string,
  ) => Promise<ReadonlyArray<{ readonly appId: string }>> = noDiscover,
): Promise<ReadonlyArray<string>> => {
  const result = await Effect.runPromise(
    listServices({
      userDataRoot: dataRoot,
      userCacheRoot: cacheRoot,
      path,
      discoverContainers,
    }).pipe(Effect.provide(fakeConfigService(dataRoot))),
  );
  return result.apps.map((app) => app.appName);
};

const withListRoots = async (run: (dataRoot: string, cacheRoot: string) => Promise<void>): Promise<void> => {
  const dataRoot = await mkdtemp(join(tmpdir(), "lando-apps-list-path-data-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "lando-apps-list-path-cache-"));
  try {
    await run(dataRoot, cacheRoot);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
};

describe("apps:list --path resolved matching", () => {
  test("matches a stored root through a symlink to that directory", async () => {
    await withListRoots(async (dataRoot, cacheRoot) => {
      const workspace = await mkdtemp(join(tmpdir(), "lando-apps-list-path-link-"));
      try {
        const appDir = join(workspace, "real-app");
        const linkDir = join(workspace, "link-app");
        await mkdir(appDir);
        await symlink(appDir, linkDir);
        const storedRoot = await realpath(appDir);
        await writeAppliedPlan(dataRoot, "linked", storedRoot);
        await writeAppliedPlan(dataRoot, "other", join(workspace, "other-app"));
        expect(await listNames(dataRoot, cacheRoot, linkDir)).toEqual(["linked"]);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
  });

  test("matches a stored root from a relative path against cwd", async () => {
    await withListRoots(async (dataRoot, cacheRoot) => {
      const workspace = await mkdtemp(join(tmpdir(), "lando-apps-list-path-rel-"));
      try {
        const appDir = join(workspace, "projects", "relative-app");
        await mkdir(appDir, { recursive: true });
        const storedRoot = await realpath(appDir);
        await writeAppliedPlan(dataRoot, "relative", storedRoot);
        await writeAppliedPlan(dataRoot, "other", join(workspace, "other-app"));
        await withCwd(
          workspace,
          async () => {
            expect(await listNames(dataRoot, cacheRoot, relative(workspace, appDir))).toEqual(["relative"]);
            expect(await listNames(dataRoot, cacheRoot, "projects")).toEqual(["relative"]);
          },
          [workspace, dataRoot, cacheRoot],
        );
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
  });

  test("matches a stored root from a ~/ path after home expansion", async () => {
    await withListRoots(async (dataRoot, cacheRoot) => {
      const home = await mkdtemp(join(tmpdir(), "lando-apps-list-path-home-"));
      try {
        const appDir = join(home, "projects", "home-app");
        await mkdir(appDir, { recursive: true });
        const storedRoot = await realpath(appDir);
        await writeAppliedPlan(dataRoot, "homeapp", storedRoot);
        await writeAppliedPlan(dataRoot, "other", join(home, "other-app"));
        await withEnvVar("HOME", home, async () => {
          expect(await listNames(dataRoot, cacheRoot, "~/projects/home-app")).toEqual(["homeapp"]);
          expect(await listNames(dataRoot, cacheRoot, "~/projects")).toEqual(["homeapp"]);
        });
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });
  });

  test("falls back to substring matching when the path does not exist", async () => {
    await withListRoots(async (dataRoot, cacheRoot) => {
      await writeAppliedPlan(dataRoot, "alpha", "/srv/projects/filter-alpha");
      await writeAppliedPlan(dataRoot, "bravo", "/srv/projects/filter-bravo");
      expect(await listNames(dataRoot, cacheRoot, "/projects/filter-alpha")).toEqual(["alpha"]);
    });
  });

  test("keeps plain substring matching on the stored root", async () => {
    await withListRoots(async (dataRoot, cacheRoot) => {
      await writeAppliedPlan(dataRoot, "alpha", "/srv/filter-alpha");
      await writeAppliedPlan(dataRoot, "bravo", "/srv/filter-bravo");
      expect(await listNames(dataRoot, cacheRoot, "filter-alpha")).toEqual(["alpha"]);
    });
  });

  test("resolves the path filter once after a single discovery pass", async () => {
    await withListRoots(async (dataRoot, cacheRoot) => {
      const workspace = await mkdtemp(join(tmpdir(), "lando-apps-list-path-once-"));
      try {
        const appDir = join(workspace, "once-app");
        await mkdir(appDir);
        const storedRoot = await realpath(appDir);
        await writeAppliedPlan(dataRoot, "once", storedRoot);
        let discoveries = 0;
        const names = await listNames(dataRoot, cacheRoot, appDir, async () => {
          discoveries += 1;
          return [];
        });
        expect(names).toEqual(["once"]);
        expect(discoveries).toBe(1);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
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
      "DOCKER_HOST",
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
