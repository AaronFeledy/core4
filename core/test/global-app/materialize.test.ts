import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer, Schema } from "effect";

import {
  GlobalAppError,
  GlobalDistConflictError,
  GlobalLandofilePathConflictError,
} from "@lando/core/errors";
import { LandofileShape, type ServiceConfig } from "@lando/core/schema";
import { GlobalAppService } from "@lando/core/services";

import { GlobalAppServiceLive } from "../../src/global-app/service.ts";
import { parseLandofile } from "../../src/landofile/parser.ts";
import { ConfigServiceLive } from "../../src/services/config.ts";
import { FileSystemLive } from "../../src/services/file-system.ts";

const globalAppLayer = GlobalAppServiceLive.pipe(
  Layer.provide(Layer.mergeAll(ConfigServiceLive, FileSystemLive)),
);

const overlayContent = [
  "# User overrides for the global Lando app.",
  "# Generated services live in .lando.dist.yml (merged before this file).",
  "",
].join("\n");

const withTempRoots = async <T>(run: (dataRoot: string) => Promise<T>): Promise<T> => {
  const dataRoot = await mkdtemp(join(tmpdir(), "lando-global-materialize-data-"));
  const confRoot = await mkdtemp(join(tmpdir(), "lando-global-materialize-conf-"));
  const previousData = process.env.LANDO_USER_DATA_ROOT;
  const previousConf = process.env.LANDO_USER_CONF_ROOT;
  try {
    process.env.LANDO_USER_DATA_ROOT = dataRoot;
    process.env.LANDO_USER_CONF_ROOT = confRoot;
    return await run(dataRoot);
  } finally {
    // biome-ignore lint/performance/noDelete: process.env delete preserves the originally unset state.
    if (previousData === undefined) delete process.env.LANDO_USER_DATA_ROOT;
    else process.env.LANDO_USER_DATA_ROOT = previousData;
    // biome-ignore lint/performance/noDelete: process.env delete preserves the originally unset state.
    if (previousConf === undefined) delete process.env.LANDO_USER_CONF_ROOT;
    else process.env.LANDO_USER_CONF_ROOT = previousConf;
    await rm(dataRoot, { recursive: true, force: true });
    await rm(confRoot, { recursive: true, force: true });
  }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const runWithGlobalApp = <A, E>(effect: Effect.Effect<A, E, GlobalAppService>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(globalAppLayer)));

const runWithGlobalAppExit = <A, E>(effect: Effect.Effect<A, E, GlobalAppService>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(globalAppLayer)));

const materializeDist = (services?: Record<string, ServiceConfig>) =>
  Effect.flatMap(GlobalAppService, (service) => service.regenerateDist({ services }));

const ensureOverlay = () => Effect.flatMap(GlobalAppService, (service) => service.ensureUserLandofile);

const parse = (content: string) =>
  Effect.runPromise(parseLandofile({ file: ".lando.dist.yml", content, cwd: "/tmp" }));

const parseAndValidate = async (content: string) => {
  const parsed = await parse(content);
  return Schema.decodeUnknownSync(LandofileShape)(parsed);
};

const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const failure = Cause.failureOption(exit.cause);
  expect(failure._tag).toBe("Some");
  if (failure._tag !== "Some") throw new Error("expected typed failure");
  return failure.value;
};

describe("global Landofile parser forms", () => {
  test("comment-only overlays parse as an empty object", async () => {
    await expect(parse(overlayContent)).resolves.toEqual({});
  });

  test("an empty services block parses as an empty services object", async () => {
    await expect(parse("services:\n")).resolves.toEqual({ services: {} });
  });
});

describe("GlobalAppService Landofile materialization", () => {
  test("regenerateDist creates and then leaves an unchanged empty dist file untouched", async () => {
    await withTempRoots(async (dataRoot) => {
      const distPath = join(dataRoot, "global", ".lando.dist.yml");

      const created = await runWithGlobalApp(materializeDist({}));
      const firstContent = await readFile(distPath, "utf8");
      const firstStat = await stat(distPath);
      const parsed = await parseAndValidate(firstContent);

      await sleep(25);
      const unchanged = await runWithGlobalApp(materializeDist({}));
      const secondContent = await readFile(distPath, "utf8");
      const secondStat = await stat(distPath);

      expect(created).toEqual({ path: distPath, status: "created", serviceIds: [] });
      expect(unchanged).toEqual({ path: distPath, status: "unchanged", serviceIds: [] });
      expect(secondContent).toBe(firstContent);
      expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
      expect(parsed).toEqual({ name: "global", runtime: 4, services: {} });
    });
  });

  test("regenerateDist emits sorted service ids and a schema-valid services block", async () => {
    await withTempRoots(async (dataRoot) => {
      const services: Record<string, ServiceConfig> = {
        web: { type: "node", image: "node:lts", primary: true },
      };

      const result = await runWithGlobalApp(materializeDist(services));
      const content = await readFile(join(dataRoot, "global", ".lando.dist.yml"), "utf8");
      const parsed = await parseAndValidate(content);

      expect(result.serviceIds).toEqual(["web"]);
      expect(parsed).toEqual({
        name: "global",
        runtime: 4,
        services: {
          web: { type: "node", image: "node:lts", primary: true },
        },
      });
    });
  });

  test("regenerateDist indents nested array-of-record children under the array marker", async () => {
    await withTempRoots(async (dataRoot) => {
      const services: Record<string, ServiceConfig> = {
        web: {
          type: "node",
          mounts: [{ excludes: ["node_modules"], target: "/app" }],
        },
      };

      await runWithGlobalApp(materializeDist(services));
      const content = await readFile(join(dataRoot, "global", ".lando.dist.yml"), "utf8");
      const parsed = await parseAndValidate(content);

      expect(content).toContain(
        ["    mounts:", "      - excludes:", "          - node_modules", "        target: /app"].join("\n"),
      );
      expect(parsed.services?.web?.mounts).toEqual([{ excludes: ["node_modules"], target: "/app" }]);
    });
  });

  test("regenerateDist escapes control characters in quoted scalars", async () => {
    await withTempRoots(async (dataRoot) => {
      const services: Record<string, ServiceConfig> = {
        web: {
          type: "node",
          environment: {
            MULTILINE: "line one\nline two",
            RETURN: "left\rright",
            TAB: "left\tright",
          },
        },
      };

      await runWithGlobalApp(materializeDist(services));
      const content = await readFile(join(dataRoot, "global", ".lando.dist.yml"), "utf8");
      const parsed = await parseAndValidate(content);

      expect(content).toContain('      MULTILINE: "line one\\nline two"');
      expect(content).toContain('      RETURN: "left\\rright"');
      expect(content).toContain('      TAB: "left\\tright"');
      expect(parsed.services?.web?.environment).toEqual({
        MULTILINE: "line one\nline two",
        RETURN: "left\rright",
        TAB: "left\tright",
      });
    });
  });

  test("regenerateDist quotes scalars that look like quoted YAML strings", async () => {
    await withTempRoots(async (dataRoot) => {
      const services: Record<string, ServiceConfig> = {
        web: {
          type: "node",
          environment: {
            DOUBLE_WRAPPED: '"hello"',
            SINGLE_WRAPPED: "'hello'",
          },
        },
      };

      await runWithGlobalApp(materializeDist(services));
      const content = await readFile(join(dataRoot, "global", ".lando.dist.yml"), "utf8");
      const parsed = await parseAndValidate(content);

      expect(content).toContain(`      DOUBLE_WRAPPED: '"hello"'`);
      expect(content).toContain("      SINGLE_WRAPPED: \"'hello'\"");
      expect(parsed.services?.web?.environment).toEqual({
        DOUBLE_WRAPPED: '"hello"',
        SINGLE_WRAPPED: "'hello'",
      });
    });
  });

  test("regenerateDist round-trips provider nested arrays with comma scalars", async () => {
    await withTempRoots(async (dataRoot) => {
      const services: Record<string, ServiceConfig> = {
        web: {
          type: "node",
          providers: {
            docker: { matrix: [["hello, world", "foo"]] },
          },
        },
      };

      await runWithGlobalApp(materializeDist(services));
      const content = await readFile(join(dataRoot, "global", ".lando.dist.yml"), "utf8");
      const parsed = await parseAndValidate(content);

      expect(content).toContain('        - ["hello, world","foo"]');
      expect(parsed.services?.web?.providers).toEqual({
        docker: { matrix: [["hello, world", "foo"]] },
      });
    });
  });

  test("regenerateDist quotes list scalars that look like map entries", async () => {
    await withTempRoots(async (dataRoot) => {
      const services: Record<string, ServiceConfig> = {
        web: {
          type: "node",
          cores: ["type: node", "app:"],
          volumes: ["source: target", "cache:"],
        },
      };

      await runWithGlobalApp(materializeDist(services));
      const content = await readFile(join(dataRoot, "global", ".lando.dist.yml"), "utf8");
      const parsed = await parseAndValidate(content);

      expect(content).toContain("      - 'type: node'");
      expect(content).toContain("      - 'source: target'");
      expect(content).toContain("      - 'app:'");
      expect(content).toContain("      - 'cache:'");
      expect(parsed.services?.web?.cores).toEqual(["type: node", "app:"]);
      expect(parsed.services?.web?.volumes).toEqual(["source: target", "cache:"]);
    });
  });

  test("regenerateDist rejects a foreign .lando.dist.yml", async () => {
    await withTempRoots(async (dataRoot) => {
      const root = join(dataRoot, "global");
      const distPath = join(root, ".lando.dist.yml");
      await mkdir(root, { recursive: true });
      await writeFile(distPath, "name: user-authored\n");

      const exit = await runWithGlobalAppExit(materializeDist({}));
      const failure = failureOf(exit);

      expect(failure).toBeInstanceOf(GlobalDistConflictError);
      expect((failure as GlobalDistConflictError).reason).toBe("foreign-file");
      expect((failure as GlobalDistConflictError).path).toBe(distPath);
    });
  });

  test("regenerateDist rejects manual edits to a managed .lando.dist.yml", async () => {
    await withTempRoots(async (dataRoot) => {
      const root = join(dataRoot, "global");
      const distPath = join(root, ".lando.dist.yml");
      await mkdir(root, { recursive: true });
      await writeFile(
        distPath,
        [
          "# DO NOT EDIT — regenerated by Lando.",
          "# Put global app overrides in .lando.yml (merged after this file).",
          "# lando-global-dist-sha256: 0000000000000000000000000000000000000000000000000000000000000000",
          "name: global",
          "runtime: 4",
          "services:",
          "",
        ].join("\n"),
      );

      const exit = await runWithGlobalAppExit(materializeDist({}));
      const failure = failureOf(exit);

      expect(failure).toBeInstanceOf(GlobalDistConflictError);
      expect((failure as GlobalDistConflictError).reason).toBe("manual-edit");
      expect((failure as GlobalDistConflictError).path).toBe(distPath);
    });
  });

  test("regenerateDist accepts managed dist files read back with CRLF line endings", async () => {
    await withTempRoots(async (dataRoot) => {
      const distPath = join(dataRoot, "global", ".lando.dist.yml");

      await runWithGlobalApp(materializeDist({}));
      const content = await readFile(distPath, "utf8");
      await writeFile(distPath, content.replace(/\n/g, "\r\n"));

      const result = await runWithGlobalApp(materializeDist({}));

      expect(result.status).toBe("updated");
    });
  });

  test("ensureUserLandofile creates the overlay once and preserves user edits", async () => {
    await withTempRoots(async (dataRoot) => {
      const userPath = join(dataRoot, "global", ".lando.yml");

      const created = await runWithGlobalApp(ensureOverlay());
      expect(created).toEqual({ path: userPath, created: true });
      expect(await readFile(userPath, "utf8")).toBe(overlayContent);

      await writeFile(userPath, "name: custom-global\n");
      await runWithGlobalApp(materializeDist({}));
      const preserved = await runWithGlobalApp(ensureOverlay());

      expect(preserved).toEqual({ path: userPath, created: false });
      expect(await readFile(userPath, "utf8")).toBe("name: custom-global\n");
    });
  });

  test("ensureUserLandofile rejects a directory at the overlay path", async () => {
    await withTempRoots(async (dataRoot) => {
      const root = join(dataRoot, "global");
      const userPath = join(root, ".lando.yml");
      await mkdir(userPath, { recursive: true });

      const exit = await runWithGlobalAppExit(ensureOverlay());
      const failure = failureOf(exit);

      expect(failure).toBeInstanceOf(GlobalLandofilePathConflictError);
      expect((failure as GlobalLandofilePathConflictError).expected).toBe("file");
      expect((failure as GlobalLandofilePathConflictError).actual).toBe("directory");
      expect((failure as GlobalLandofilePathConflictError).path).toBe(userPath);
    });
  });
});

describe("globalInstall command operation", () => {
  test("materializes both global Landofile files", async () => {
    await withTempRoots(async (dataRoot) => {
      const { globalInstall } = await import("../../src/cli/commands/meta/global-install.ts");
      const result = await runWithGlobalApp(globalInstall({}));

      expect(result).toEqual({
        paths: {
          root: join(dataRoot, "global"),
          distLandofile: join(dataRoot, "global", ".lando.dist.yml"),
          userLandofile: join(dataRoot, "global", ".lando.yml"),
        },
        dist: {
          path: join(dataRoot, "global", ".lando.dist.yml"),
          status: "created",
          serviceIds: [],
        },
        userLandofileCreated: true,
      });
      expect(await readFile(result.dist.path, "utf8")).toContain("name: global\nruntime: 4\nservices:\n");
      expect(await readFile(result.paths.userLandofile, "utf8")).toBe(overlayContent);
    });
  });

  test("fails plugin-specific enablement with a tagged remediation", async () => {
    await withTempRoots(async () => {
      const { globalInstall } = await import("../../src/cli/commands/meta/global-install.ts");
      const exit = await runWithGlobalAppExit(globalInstall({ plugin: "x" }));
      const failure = failureOf(exit);

      expect(failure).toBeInstanceOf(GlobalAppError);
      expect((failure as GlobalAppError).operation).toBe("install");
      expect((failure as GlobalAppError).remediation).toContain("lando global:install");
    });
  });
});
