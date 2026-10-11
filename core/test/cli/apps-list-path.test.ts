import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeCwd } from "@lando/engine/runtime/cwd";
import { GlobalConfig } from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { appsListPathFromInput } from "../../src/cli/command-specs/apps/list.ts";
import { appliedPlansDirectory, listServices } from "../../src/cli/commands/list.ts";
import { compiledCommandInputFromArgv } from "../../src/cli/compiled-input.ts";
import { MalformedCliFlagValueError } from "../../src/cli/flag-value-validation.ts";
import { ensureCompiledCli } from "../_support/compiled-cli.ts";
import { withEnvVar } from "../_support/temp-cwd.ts";

describe("apps:list --path extraction seam", () => {
  for (const argv of [["--path", "demo"], ["--path=demo"]]) {
    test(`reads ${argv.join(" ")}`, () => {
      expect(appsListPathFromInput(compiledCommandInputFromArgv("apps:list", argv))).toBe("demo");
    });
  }
  test("is undefined when the flag is absent", () => {
    expect(appsListPathFromInput(compiledCommandInputFromArgv("apps:list", []))).toBeUndefined();
  });
  test("rejects a valueless --path", () => {
    expect(() => appsListPathFromInput(compiledCommandInputFromArgv("apps:list", ["--path"]))).toThrow(
      MalformedCliFlagValueError,
    );
  });
  test("reads native inputs", () => {
    expect(appsListPathFromInput({ flags: { path: "demo" } })).toBe("demo");
    expect(appsListPathFromInput({ flags: {} })).toBeUndefined();
    expect(appsListPathFromInput(undefined)).toBeUndefined();
  });
});

const makePlan = (id: string, root: string) => ({
  version: 1,
  data: {
    id,
    name: id,
    slug: id,
    root,
    provider: "lando",
    services: { web: { name: "web", type: "lando.app", primary: false, env: {} } },
  },
});

describe("apps:list --path resolved matching", () => {
  let root: string;
  let app: string;
  let dataRoot: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "lando-list-resolved-"));
    app = join(root, "projects", "my.site");
    dataRoot = join(root, "data");
    await mkdir(app, { recursive: true });
    await mkdir(join(root, "projects-extra"));
    await symlink(app, join(root, "drupal"), process.platform === "win32" ? "junction" : "dir");
    const plans = appliedPlansDirectory(dataRoot);
    await mkdir(plans, { recursive: true });
    for (const [id, path] of [
      ["canonical", app],
      ["linked", join(root, "drupal")],
      ["sibling", join(root, "projects-extra")],
      ["substring", "/srv/drupal-cms"],
    ] as const) {
      await writeFile(join(plans, `${id}.json`), JSON.stringify(makePlan(id, path)));
    }
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const list = async (path: string, status?: ReadonlyArray<"active" | "stopped" | "unknown">) => {
    const config = Schema.decodeUnknownSync(GlobalConfig)({});
    let discoveries = 0;
    const result = await Effect.runPromise(
      listServices({
        userDataRoot: dataRoot,
        userCacheRoot: join(root, "cache"),
        path,
        ...(status === undefined ? {} : { status }),
        discoverContainers: async () => {
          discoveries += 1;
          return [
            {
              appId: "canonical",
              appName: "canonical",
              providerId: "lando",
              appRoot: app,
              services: ["web"],
            },
            {
              appId: "container-only",
              appName: "container-only",
              providerId: "lando",
              appRoot: "",
              services: ["web"],
            },
          ];
        },
      }).pipe(
        Effect.provideService(ConfigService, {
          load: Effect.succeed(config),
          get: (key) => Effect.succeed(config[key]),
        }),
        Effect.provideService(RuntimeCwd, root),
      ),
    );
    expect(discoveries).toBe(1);
    return result.apps.map((entry) => entry.appName);
  };

  for (const path of ["./drupal", "./projects", "projects/my.site", "./projects/my.site/", "~/projects"]) {
    test(`matches canonical and symlink-stored roots with ${path}`, async () => {
      await withEnvVar("HOME", root, async () => {
        expect(await list(path)).toEqual(["canonical", "linked"]);
      });
    });
  }
  test("matches absolute paths", async () => {
    expect(await list(app)).toEqual(["canonical", "linked"]);
  });
  test.skipIf(process.platform !== "win32")("accepts Windows separators", async () => {
    expect(await list(".\\projects")).toEqual(["canonical", "linked"]);
  });
  test.skipIf(process.platform !== "win32" && process.platform !== "darwin")(
    "matches alternate casing when the filesystem resolves it",
    async () => {
      const alternate = app.replace("my.site", "MY.SITE");
      const exists = await realpath(alternate).then(
        () => true,
        () => false,
      );
      expect(await list(alternate)).toEqual(exists ? ["canonical", "linked"] : []);
    },
  );
  test("matches cwd without treating dots or empty roots as substrings", async () => {
    expect(await list(".")).toEqual(["canonical", "linked", "sibling"]);
  });
  test("matches the parent directory with ..", async () => {
    expect(await list("./projects/..")).toEqual(["canonical", "linked", "sibling"]);
  });
  test("keeps bare words as substrings even when a folder exists", async () => {
    expect(await list("drupal")).toEqual(["linked", "substring"]);
  });
  test("falls back to substrings for nonexistent path-like values", async () => {
    expect(await list("/srv/drupal")).toEqual(["substring"]);
  });
  test("combines path and status after one discovery", async () => {
    expect(await list("./projects", ["active"])).toEqual(["canonical"]);
  });
});

describe.skipIf(process.platform !== "linux" || process.arch !== "x64")("apps:list --path compiled", () => {
  let binary: string;
  let root: string;
  let env: Record<string, string | undefined>;
  beforeAll(async () => {
    binary = await ensureCompiledCli();
    root = await mkdtemp(join(tmpdir(), "lando-list-compiled-"));
    const plans = appliedPlansDirectory(join(root, "data"));
    await mkdir(plans, { recursive: true });
    await mkdir(join(root, "app"));
    for (const [id, path] of [
      ["alpha", join(root, "app")],
      ["bravo", "/srv/filter-bravo"],
    ] as const) {
      await writeFile(join(plans, `${id}.json`), JSON.stringify(makePlan(id, path)));
    }
    env = {
      ...process.env,
      LANDO_USER_DATA_ROOT: join(root, "data"),
      LANDO_USER_CACHE_ROOT: join(root, "cache"),
      LANDO_USER_CONF_ROOT: join(root, "conf"),
    };
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

  for (const [command, args, names] of [
    ["apps:list", ["--path", "app"], ["alpha"]],
    ["list", ["--path", "./app"], ["alpha"]],
    ["apps:list", ["--path=filter-bravo"], ["bravo"]],
    ["apps:list", [], ["alpha", "bravo"]],
  ] as const) {
    test(`${command} ${args.join(" ")}`, async () => {
      const proc = Bun.spawn({
        cmd: [binary, command, ...args, "--format=json"],
        cwd: root,
        env,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      const envelope = Schema.decodeUnknownSync(
        Schema.Struct({
          ok: Schema.Literal(true),
          result: Schema.Struct({ apps: Schema.Array(Schema.Struct({ appName: Schema.String })) }),
        }),
      )(JSON.parse(stdout));
      expect(envelope.result.apps.map((entry) => entry.appName)).toEqual([...names]);
    });
  }
});
