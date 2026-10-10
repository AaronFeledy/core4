import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { Effect, Layer } from "effect";

import { ConfigService } from "@lando/sdk/services";

import { RuntimeCwd } from "@lando/engine/runtime/cwd";

import { appsListPathFromInput } from "../../src/cli/command-specs/apps/list.ts";
import {
  type AppsListEntry,
  type AppsListStatus,
  appliedPlansDirectory,
  listServices,
} from "../../src/cli/commands/list.ts";
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

const listResult = async (
  dataRoot: string,
  cacheRoot: string,
  options: {
    readonly path: string;
    readonly status?: ReadonlyArray<AppsListStatus>;
    readonly discoverContainers?: (userDataRoot: string) => Promise<ReadonlyArray<AppsListEntry>>;
    readonly runtimeCwd?: string;
  },
) => {
  const listed = listServices({
    userDataRoot: dataRoot,
    userCacheRoot: cacheRoot,
    path: options.path,
    ...(options.status === undefined ? {} : { status: options.status }),
    discoverContainers: options.discoverContainers ?? noDiscover,
  }).pipe(Effect.provide(fakeConfigService(dataRoot)));
  return await Effect.runPromise(
    options.runtimeCwd === undefined
      ? listed
      : listed.pipe(Effect.provideService(RuntimeCwd, options.runtimeCwd)),
  );
};

const listNames = async (
  dataRoot: string,
  cacheRoot: string,
  path: string,
  discoverContainers: (userDataRoot: string) => Promise<ReadonlyArray<AppsListEntry>> = noDiscover,
): Promise<ReadonlyArray<string>> =>
  (await listResult(dataRoot, cacheRoot, { path, discoverContainers })).apps.map((app) => app.appName);

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
            expect(await listNames(dataRoot, cacheRoot, "./projects")).toEqual(["relative"]);
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

  test("does not match a sibling prefix when a path-like filter exists", async () => {
    await withListRoots(async (dataRoot, cacheRoot) => {
      const workspace = await mkdtemp(join(tmpdir(), "lando-apps-list-path-prefix-"));
      try {
        const foo = join(workspace, "foo");
        const foobar = join(workspace, "foobar");
        await mkdir(foo);
        await mkdir(foobar);
        await writeAppliedPlan(dataRoot, "foo", await realpath(foo));
        await writeAppliedPlan(dataRoot, "foobar", await realpath(foobar));
        expect(await listNames(dataRoot, cacheRoot, foo)).toEqual(["foo"]);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
  });

  test("does not match a stored root that only contains a dot when filtering with .", async () => {
    await withListRoots(async (dataRoot, cacheRoot) => {
      const workspace = await mkdtemp(join(tmpdir(), "lando-apps-list-path-dot-"));
      try {
        const cwd = join(workspace, "foo");
        const site = join(workspace, "my.site");
        await mkdir(cwd);
        await mkdir(site);
        await writeAppliedPlan(dataRoot, "inside", await realpath(cwd));
        await writeAppliedPlan(dataRoot, "site", await realpath(site));
        await withCwd(
          cwd,
          async () => {
            expect(await listNames(dataRoot, cacheRoot, ".")).toEqual(["inside"]);
          },
          [workspace, dataRoot, cacheRoot],
        );
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
  });

  test("does not path-match an empty container-only root with . or /", async () => {
    await withListRoots(async (dataRoot, cacheRoot) => {
      const workspace = await mkdtemp(join(tmpdir(), "lando-apps-list-path-empty-"));
      try {
        await writeAppliedPlan(dataRoot, "inside", await realpath(workspace));
        const discoverContainers = async (): Promise<ReadonlyArray<AppsListEntry>> => [
          {
            appId: "container-only",
            appName: "container-only",
            providerId: "lando",
            appRoot: "",
            services: ["web"],
          },
        ];
        await withCwd(
          workspace,
          async () => {
            expect(await listNames(dataRoot, cacheRoot, ".", discoverContainers)).toEqual(["inside"]);
            expect(await listNames(dataRoot, cacheRoot, "/", discoverContainers)).toEqual(["inside"]);
          },
          [workspace, dataRoot, cacheRoot],
        );
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
  });

  test("keeps substring behavior for a bare word that exists as a folder", async () => {
    await withListRoots(async (dataRoot, cacheRoot) => {
      const workspace = await mkdtemp(join(tmpdir(), "lando-apps-list-path-bare-"));
      try {
        const target = join(workspace, "web");
        const link = join(workspace, "drupal");
        await mkdir(target);
        await symlink(target, link);
        await writeAppliedPlan(dataRoot, "folder", await realpath(target));
        await writeAppliedPlan(dataRoot, "named", "/srv/drupal-cms");
        await withCwd(
          workspace,
          async () => {
            expect(await listNames(dataRoot, cacheRoot, "drupal")).toEqual(["named"]);
            expect(await listNames(dataRoot, cacheRoot, "./drupal")).toEqual(["folder"]);
          },
          [workspace, dataRoot, cacheRoot],
        );
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
  });

  test("resolves a relative path against RuntimeCwd instead of process cwd", async () => {
    await withListRoots(async (dataRoot, cacheRoot) => {
      const session = await mkdtemp(join(tmpdir(), "lando-apps-list-path-cwd-"));
      const elsewhere = await mkdtemp(join(tmpdir(), "lando-apps-list-path-else-"));
      try {
        const appDir = join(session, "app");
        await mkdir(appDir);
        await writeAppliedPlan(dataRoot, "session", await realpath(appDir));
        await writeAppliedPlan(dataRoot, "other", join(elsewhere, "app"));
        await withCwd(
          elsewhere,
          async () => {
            const names = (
              await listResult(dataRoot, cacheRoot, { path: "./app", runtimeCwd: session })
            ).apps.map((app) => app.appName);
            expect(names).toEqual(["session"]);
          },
          [session, elsewhere, dataRoot, cacheRoot],
        );
      } finally {
        await rm(session, { recursive: true, force: true });
        await rm(elsewhere, { recursive: true, force: true });
      }
    });
  });

  test("applies --path and --status after the same discovery pass", async () => {
    await withListRoots(async (dataRoot, cacheRoot) => {
      const workspace = await mkdtemp(join(tmpdir(), "lando-apps-list-path-status-"));
      try {
        const parent = join(workspace, "apps");
        const activeDir = join(parent, "active-app");
        const stoppedDir = join(parent, "stopped-app");
        await mkdir(activeDir, { recursive: true });
        await mkdir(stoppedDir, { recursive: true });
        const activeRoot = await realpath(activeDir);
        const stoppedRoot = await realpath(stoppedDir);
        await writeAppliedPlan(dataRoot, "active-app", activeRoot);
        await writeAppliedPlan(dataRoot, "stopped-app", stoppedRoot);
        const result = await listResult(dataRoot, cacheRoot, {
          path: parent,
          status: ["active"],
          discoverContainers: async () => [
            {
              appId: "active-app",
              appName: "active-app",
              providerId: "lando",
              appRoot: activeRoot,
              services: ["web"],
            },
          ],
        });
        expect(result.apps.map((app) => ({ name: app.appName, status: app.status }))).toEqual([
          { name: "active-app", status: "active" },
        ]);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
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
