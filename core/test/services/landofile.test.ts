import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";

import {
  LandofileFormConflictError,
  LandofileNotFoundError,
  LandofileParseError,
  LandofileValidationError,
  NotImplementedError,
} from "@lando/core/errors";
import { ServiceName } from "@lando/core/schema";
import { LandofileService } from "@lando/core/services";
import { getVersionConstraintEntries } from "../../src/config/version-constraint.ts";
import { findAppRoot, findLandofilePath } from "../../src/landofile/discovery.ts";
import { LandofileServiceLive } from "../../src/landofile/service.ts";

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-landofile-service-"));
  const previousCwd = process.cwd();
  try {
    return await run(dir);
  } finally {
    process.chdir(previousCwd);
    await rm(dir, { recursive: true, force: true });
  }
};

const discover = () =>
  Effect.runPromise(
    Effect.flatMap(LandofileService, (landofileService) => landofileService.discover).pipe(
      Effect.provide(LandofileServiceLive),
    ),
  );

const discoverExit = () =>
  Effect.runPromiseExit(
    Effect.flatMap(LandofileService, (landofileService) => landofileService.discover).pipe(
      Effect.provide(LandofileServiceLive),
    ),
  );

describe("LandofileServiceLive", () => {
  test("loads all six normative positions in precedence order and accumulates provenance", async () => {
    await withTempCwd(async (dir) => {
      const files = [
        ".lando.base.yml",
        ".lando.dist.ts",
        ".lando.upstream.yml",
        ".lando.yml",
        ".lando.local.yml",
        ".lando.user.yml",
      ] as const;
      for (const [order, file] of files.entries()) {
        await writeFile(
          join(dir, file),
          file.endsWith(".ts")
            ? `export default { name: "layer-${order}", lando: ">=${order}.0.0" };\n`
            : `name: layer-${order}\nlando: \">=${order}.0.0\"\n`,
        );
      }
      process.chdir(dir);

      const resolved = await discover();

      expect(resolved.name).toBe("layer-5");
      expect(getVersionConstraintEntries(resolved, "fallback")).toEqual([
        { range: ">=0.0.0", source: join(dir, files[0]), layer: "base", order: 0 },
        { range: ">=1.0.0", source: join(dir, files[1]), layer: "dist", order: 1 },
        { range: ">=2.0.0", source: join(dir, files[2]), layer: "upstream", order: 2 },
        { range: ">=3.0.0", source: join(dir, files[3]), layer: "canonical", order: 3 },
        { range: ">=4.0.0", source: join(dir, files[4]), layer: "local", order: 4 },
        { range: ">=5.0.0", source: join(dir, files[5]), layer: "user", order: 5 },
      ]);
    });
  });

  test("skips missing optional layers", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), "name: canonical\n");
      process.chdir(dir);
      expect((await discover()).name).toBe("canonical");
    });
  });

  test("discovers an app root from a noncanonical merge layer", async () => {
    await withTempCwd(async (dir) => {
      const appRoot = join(dir, "app");
      const nested = join(appRoot, "src", "nested");
      const layerPath = join(appRoot, ".lando.dist.yml");
      await mkdir(nested, { recursive: true });
      await writeFile(layerPath, "name: dist-only\n");
      process.chdir(nested);

      expect(await findLandofilePath(nested)).toBe(layerPath);
      expect(await findAppRoot(nested)).toBe(appRoot);
      expect((await discover()).name).toBe("dist-only");
    });
  });

  test("preserves nested include source while inheriting layer and order", async () => {
    await withTempCwd(async (dir) => {
      const fragmentPath = join(dir, "constraints.yml");
      await writeFile(fragmentPath, 'lando: ">=4.2"\n');
      await writeFile(
        join(dir, ".lando.local.yml"),
        ["includes:", "  - ./constraints.yml", 'lando: "<5"', ""].join("\n"),
      );
      await writeFile(join(dir, ".lando.yml"), "name: canonical\n");
      process.chdir(dir);

      const resolved = await discover();

      expect(getVersionConstraintEntries(resolved, "fallback")).toEqual([
        { range: ">=4.2", source: fragmentPath, layer: "local", order: 4 },
        { range: "<5", source: join(dir, ".lando.local.yml"), layer: "local", order: 4 },
      ]);
    });
  });

  test("rejects malformed lando ranges as LandofileParseError during load", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), "name: bad\nlando: definitely-not-semver\n");
      process.chdir(dir);

      const exit = await discoverExit();

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") expect(failure.value).toBeInstanceOf(LandofileParseError);
      }
    });
  });

  test("fails when one layer contains both YAML and TypeScript forms", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), "name: canonical\n");
      await writeFile(join(dir, ".lando.local.yml"), "name: yaml\n");
      await writeFile(join(dir, ".lando.local.ts"), 'export default { name: "ts" };\n');
      process.chdir(dir);

      const exit = await discoverExit();

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") expect(failure.value).toBeInstanceOf(LandofileFormConflictError);
      }
    });
  });
  test("discovers and parses a minimal Node and Postgres .lando.yml from a subdirectory", async () => {
    await withTempCwd(async (dir) => {
      await mkdir(join(dir, "apps", "myapp", "src"), { recursive: true });
      await writeFile(
        join(dir, "apps", "myapp", ".lando.yml"),
        [
          "name: myapp",
          "runtime: 4",
          "services:",
          "  web:",
          "    image: node:lts",
          "    ports:",
          "      - 3000:3000",
          "    environment:",
          "      NODE_ENV: development",
          "    volumes:",
          "      - ./src:/app",
          "    command: npm start",
          "    dependsOn:",
          "      - db",
          "  db:",
          "    image: postgres:16",
          "    environment:",
          "      POSTGRES_PASSWORD: lando",
          "",
        ].join("\n"),
      );
      process.chdir(join(dir, "apps", "myapp", "src"));

      const landofile = await discover();

      expect(landofile.name).toBe("myapp");
      const web = landofile.services?.[ServiceName.make("web")];
      const db = landofile.services?.[ServiceName.make("db")];
      expect(web?.image).toBe("node:lts");
      expect(web?.ports).toEqual(["3000:3000"]);
      expect(web?.environment).toEqual({ NODE_ENV: "development" });
      expect(web?.volumes).toEqual(["./src:/app"]);
      expect(web?.command).toBe("npm start");
      expect(web?.dependsOn).toEqual(["db"]);
      expect(db?.image).toBe("postgres:16");
      expect(db?.environment).toEqual({ POSTGRES_PASSWORD: "lando" });
    });
  });

  test("accepts remotes and sync as raw unresolved Landofile blocks", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        [
          "name: myapp",
          "runtime: 4",
          "services:",
          "  appserver:",
          "    image: node:lts",
          "  db:",
          "    image: postgres:16",
          "remotes:",
          "  pantheon:",
          "    source: pantheon",
          "    site: site-id",
          "    token: secret:pantheon-token",
          "sync:",
          "  database:",
          "    service: db",
          "  files:",
          "    service: appserver",
          "    path: /app/web/sites/default/files",
          "",
        ].join("\n"),
      );
      process.chdir(dir);

      const landofile = await discover();

      expect(landofile.remotes?.pantheon).toEqual({
        source: "pantheon",
        site: "site-id",
        token: "secret:pantheon-token",
      });
      expect(landofile.sync?.database?.service === "db").toBe(true);
      expect(landofile.sync?.files?.service === "appserver").toBe(true);
      expect(landofile.sync?.files?.path === "/app/web/sites/default/files").toBe(true);
    });
  });

  test("fails missing .lando.yml with searched paths in the message", async () => {
    await withTempCwd(async (dir) => {
      await mkdir(join(dir, "nested"), { recursive: true });
      process.chdir(join(dir, "nested"));

      const exit = await discoverExit();

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          const error = failure.value;
          expect(error).toBeInstanceOf(LandofileNotFoundError);
          if (error._tag === "LandofileNotFoundError") {
            expect(error.cwd).toBe(join(dir, "nested"));
            expect(error.message).toContain(join(dir, "nested", ".lando.yml"));
            expect(error.message).toContain(join(dir, ".lando.yml"));
          }
        }
      }
    });
  });

  test("fails malformed YAML with file path and line", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), ["name: myapp", "services", ""].join("\n"));
      process.chdir(dir);

      const exit = await discoverExit();

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          const error = failure.value;
          expect(error).toBeInstanceOf(LandofileParseError);
          if (error._tag === "LandofileParseError") {
            expect(error.filePath).toBe(join(dir, ".lando.yml"));
            expect(error.line).toBe(2);
          }
        }
      }
    });
  });

  test("rejects Compose keys outside the MVP allowlist with remediation", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        [
          "name: myapp",
          "services:",
          "  web:",
          "    type: compose",
          "    image: node:lts",
          "    deploy:",
          "      replicas: 3",
          "",
        ].join("\n"),
      );
      process.chdir(dir);

      const exit = await discoverExit();

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          const error = failure.value;
          expect(error).toBeInstanceOf(LandofileValidationError);
          if (error._tag === "LandofileValidationError") {
            expect(error.issues).toContain("services.web.deploy");
            expect(error.message).toContain("unsupported Compose-subset keys");
            expect(error.message).toContain("providers.<provider-id>");
          }
        }
      }
    });
  });

  test("reports generic MVP remediation for non-compose service keys", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        [
          "name: myapp",
          "services:",
          "  web:",
          "    type: node",
          "    image: node:lts",
          "    deploy:",
          "      replicas: 3",
          "",
        ].join("\n"),
      );
      process.chdir(dir);

      const exit = await discoverExit();

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          const error = failure.value;
          expect(error).toBeInstanceOf(LandofileValidationError);
          if (error._tag === "LandofileValidationError") {
            expect(error.issues).toContain("services.web.deploy");
            expect(error.message).toContain("unsupported MVP keys");
            expect(error.message).not.toContain("unsupported Compose-subset keys");
            expect(error.message).not.toContain("Compose compatibility");
          }
        }
      }
    });
  });

  test("reports mixed remediation for compose and non-compose service keys", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        [
          "name: myapp",
          "services:",
          "  web:",
          "    type: compose",
          "    image: node:lts",
          "    deploy:",
          "      replicas: 3",
          "  appserver:",
          "    type: node",
          "    image: node:lts",
          "    deploy:",
          "      replicas: 1",
          "",
        ].join("\n"),
      );
      process.chdir(dir);

      const exit = await discoverExit();

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          const error = failure.value;
          expect(error).toBeInstanceOf(LandofileValidationError);
          if (error._tag === "LandofileValidationError") {
            expect(error.issues).toContain("services.web.deploy");
            expect(error.issues).toContain("services");
            expect(error.message).toContain("unsupported service keys");
            expect(error.message).toContain("For type: compose services");
            expect(error.message).not.toContain("unsupported Compose-subset keys");
          }
        }
      }
    });
  });

  test("reports generic MVP remediation for compose service type errors", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        ["name: myapp", "services:", "  web:", "    type: compose", "    image: 123", ""].join("\n"),
      );
      process.chdir(dir);

      const exit = await discoverExit();

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          const error = failure.value;
          expect(error).toBeInstanceOf(LandofileValidationError);
          if (error._tag === "LandofileValidationError") {
            expect(error.issues).toContain("services.web.image");
            expect(error.message).toContain("unsupported MVP keys");
            expect(error.message).not.toContain("unsupported Compose-subset keys");
            expect(error.message).not.toContain("Compose compatibility");
          }
        }
      }
    });
  });
});

describe("LandofileServiceLive — numeric/boolean environment values", () => {
  test("coerces numeric and boolean environment values to strings", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        [
          "name: myapp",
          "services:",
          "  web:",
          "    image: node:lts",
          "    environment:",
          "      PORT: 3000",
          "      DEBUG: true",
          "      NODE_ENV: development",
          "",
        ].join("\n"),
      );
      process.chdir(dir);

      const landofile = await discover();

      const web = landofile.services?.[ServiceName.make("web")];
      expect(web?.environment).toEqual({ PORT: "3000", DEBUG: "true", NODE_ENV: "development" });
    });
  });
});

describe("LandofileServiceLive — numeric ports coercion (bugbot PR#28 finding 2)", () => {
  test("coerces numeric port scalars in ports: list to strings", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        [
          "name: myapp",
          "services:",
          "  web:",
          "    image: node:lts",
          "    ports:",
          "      - 8080",
          "      - 9000:90",
          "",
        ].join("\n"),
      );
      process.chdir(dir);

      const landofile = await discover();

      const web = landofile.services?.[ServiceName.make("web")];
      expect(web?.ports).toEqual(["8080", "9000:90"]);
    });
  });
});

describe("LandofileServiceLive — mounts, storage, and excludes (US-014)", () => {
  test("parses mounts: bind shorthand entries, volume object entries, and appMount.excludes patterns", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        [
          "name: myapp",
          "services:",
          "  web:",
          "    image: node:lts",
          "    appMount:",
          "      target: /app",
          "      excludes:",
          "        - node_modules",
          "        - vendor",
          "    mounts:",
          "      - ./config:/etc/app:ro",
          "      - type: volume",
          "        source: shared-vol",
          "        target: /data",
          "    storage:",
          "      - /var/lib/cache",
          "      - store: scoped-vol",
          "        target: /scoped",
          "        scope: app",
          "",
        ].join("\n"),
      );
      process.chdir(dir);

      const landofile = await discover();
      const web = landofile.services?.[ServiceName.make("web")];
      expect(web?.appMount).not.toBe(false);
      if (web?.appMount !== false) {
        expect(web?.appMount?.target).toBe("/app");
        expect(web?.appMount?.excludes).toEqual(["node_modules", "vendor"]);
      }
      expect(web?.mounts?.[0]).toBe("./config:/etc/app:ro");
      const volumeMount = web?.mounts?.[1];
      expect(typeof volumeMount).not.toBe("string");
      if (typeof volumeMount !== "string") {
        expect(volumeMount).toEqual({
          type: "volume",
          source: "shared-vol",
          target: "/data",
        });
      }
      const scopedStorage = web?.storage?.[1];
      expect(web?.storage?.[0]).toBe("/var/lib/cache");
      expect(typeof scopedStorage).not.toBe("string");
      if (typeof scopedStorage !== "string") {
        expect(scopedStorage).toEqual({
          store: "scoped-vol",
          target: "/scoped",
          scope: "app",
        });
      }
    });
  });
});

describe("LandofileServiceLive — Beta-only section rejection (US-014)", () => {
  const assertBetaRejection = (error: unknown, _expectedSpecSection: string): void => {
    expect(error).toBeInstanceOf(NotImplementedError);
    if (!(error instanceof NotImplementedError)) return;
    expect(error._tag).toBe("NotImplementedError");
    expect(error.remediation).toContain("not supported yet");
  };

  test("resolves top-level `includes:` during layered discovery", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, "fragment.yml"), "services:\n  db:\n    image: postgres:16\n");
      await writeFile(
        join(dir, ".lando.yml"),
        [
          "name: myapp",
          "includes:",
          "  - ./fragment.yml",
          "services:",
          "  web:",
          "    image: node:lts",
          "",
        ].join("\n"),
      );
      process.chdir(dir);

      const exit = await discoverExit();
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value.services?.[ServiceName.make("db")]?.image).toBe("postgres:16");
      }
    });
  });

  test("rejects configuration expressions ${...} with NotImplementedError + remediation", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        [
          "name: myapp",
          "services:",
          "  web:",
          "    image: node:lts",
          "    environment:",
          "      APP_HOST: ${env.HOST}",
          "",
        ].join("\n"),
      );
      process.chdir(dir);

      const exit = await discoverExit();
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") assertBetaRejection(failure.value, "not supported yet");
      }
    });
  });

  test("accepts top-level Compose `secrets:` through canonical discovery", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        [
          "name: myapp",
          "secrets:",
          "  db_password:",
          "    file: ./.secrets/db",
          "services:",
          "  web:",
          "    image: node:lts",
          "",
        ].join("\n"),
      );
      process.chdir(dir);

      const exit = await discoverExit();
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value.secrets?.db_password).toEqual({ file: "./.secrets/db" });
      }
    });
  });

  test("rejects top-level `env_file:` env overrides with NotImplementedError + remediation", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        [
          "name: myapp",
          "env_file:",
          "  - ./.env.local",
          "services:",
          "  web:",
          "    image: node:lts",
          "",
        ].join("\n"),
      );
      process.chdir(dir);

      const exit = await discoverExit();
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") assertBetaRejection(failure.value, "not supported yet");
      }
    });
  });
});

describe("LandofileServiceLive — tooling: parsing (US-017)", () => {
  test("parses tooling deprecation metadata without enabling runtime flag or arg definitions", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        [
          "name: myapp",
          "tooling:",
          "  legacy:",
          "    cmd: legacy",
          "    deprecated:",
          "      since: 4.2.0",
          "      severity: warn",
          "      note: Use replacement tooling.",
          "    flags:",
          "      old-flag:",
          "        deprecated:",
          "          since: 4.2.0",
          "          severity: warn",
          "          note: Use --new-flag.",
          "    args:",
          "      oldArg:",
          "        deprecated:",
          "          since: 4.2.0",
          "          severity: warn",
          "          note: Use newArg.",
          "",
        ].join("\n"),
      );
      process.chdir(dir);

      const landofile = await discover();

      expect(landofile.tooling?.legacy?.deprecated?.note).toBe("Use replacement tooling.");
      expect(landofile.tooling?.legacy?.flags?.["old-flag"]?.deprecated?.note).toBe("Use --new-flag.");
      expect(landofile.tooling?.legacy?.args?.oldArg?.deprecated?.note).toBe("Use newArg.");
    });
  });

  test("parses tooling tasks with cmds, service, description, and Alpha vars forms", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        [
          "name: myapp",
          "tooling:",
          "  composer:",
          "    description: Run Composer in the appserver",
          "    service: appserver",
          "    cmd: composer",
          "  test:",
          "    description: Run the test suite",
          "    service: appserver",
          "    cmds:",
          "      - composer install",
          "      - phpunit",
          "    vars:",
          "      MODE: dev",
          "      COUNT: 3",
          "      DEBUG: true",
          "      ENV:",
          "        default: development",
          "      SHA:",
          "        sh: git rev-parse HEAD",
          "      TAG:",
          "        prompt: Enter the release tag",
          "",
        ].join("\n"),
      );
      process.chdir(dir);

      const landofile = await discover();
      const composer = landofile.tooling?.composer;
      const t = landofile.tooling?.test;

      expect(composer?.description).toBe("Run Composer in the appserver");
      expect(composer?.service).toBe("appserver");
      expect(composer?.cmd).toBe("composer");

      expect(t?.service).toBe("appserver");
      expect(t?.cmds).toEqual(["composer install", "phpunit"]);
      expect(t?.vars?.MODE).toBe("dev");
      expect(t?.vars?.COUNT).toBe(3);
      expect(t?.vars?.DEBUG).toBe(true);
      expect(t?.vars?.ENV).toEqual({ default: "development" });
      expect(t?.vars?.SHA).toEqual({ sh: "git rev-parse HEAD" });
      expect(t?.vars?.TAG).toEqual({ prompt: "Enter the release tag" });
    });
  });
});

describe("LandofileServiceLive — tooling: Beta-only rejection (US-017)", () => {
  const assertBetaRejection = (error: unknown, _expectedSpecSection: string): void => {
    expect(error).toBeInstanceOf(NotImplementedError);
    if (!(error instanceof NotImplementedError)) return;
    expect(error._tag).toBe("NotImplementedError");
    expect(error.remediation).toContain("not supported yet");
  };

  const assertRejectsLandofile = async (
    content: ReadonlyArray<string>,
    _expectedSpecSection: string,
  ): Promise<void> => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), content.join("\n"));
      process.chdir(dir);

      const exit = await discoverExit();
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") assertBetaRejection(failure.value, _expectedSpecSection);
      }
    });
  };

  test("rejects top-level `toolingDefaults:` with remediation", async () => {
    await assertRejectsLandofile(
      ["name: myapp", "toolingDefaults:", "  method: checksum", ""],
      "not supported yet",
    );
  });

  test("rejects top-level `toolingIncludes:` with remediation", async () => {
    await assertRejectsLandofile(
      ["name: myapp", "toolingIncludes:", "  docs:", "    file: ./docs/.lando.tasks.yml", ""],
      "not supported yet",
    );
  });

  test("rejects top-level `events:` with remediation", async () => {
    await assertRejectsLandofile(
      ["name: myapp", "events:", "  post-start:", "    - task: db-wait", ""],
      "not supported yet",
    );
  });

  test("rejects top-level `commandAliases:` with remediation", async () => {
    await assertRejectsLandofile(
      ["name: myapp", "commandAliases:", "  custom:", "    start: app-start", ""],
      "not supported yet",
    );
  });

  test("rejects per-task `deps:` field with remediation", async () => {
    await assertRejectsLandofile(
      ["name: myapp", "tooling:", "  build:", "    cmd: make", "    deps:", "      - assets", ""],
      "not supported yet",
    );
  });

  test("rejects per-task `engine:` field with remediation", async () => {
    await assertRejectsLandofile(
      ["name: myapp", "tooling:", "  echo:", "    cmd: echo hi", "    engine: host", ""],
      "not supported yet",
    );
  });

  test("rejects runtime tooling `flags:` metadata other than deprecation notices", async () => {
    await assertRejectsLandofile(
      [
        "name: myapp",
        "tooling:",
        "  echo:",
        "    cmd: echo hi",
        "    flags:",
        "      verbose:",
        "        type: boolean",
        "",
      ],
      "not supported yet",
    );
  });

  test("rejects runtime tooling `args:` metadata other than deprecation notices", async () => {
    await assertRejectsLandofile(
      [
        "name: myapp",
        "tooling:",
        "  echo:",
        "    cmd: echo hi",
        "    args:",
        "      target:",
        "        description: Deployment target",
        "",
      ],
      "not supported yet",
    );
  });

  test("rejects unsafe `raw:` var form with remediation", async () => {
    await assertRejectsLandofile(
      [
        "name: myapp",
        "tooling:",
        "  run:",
        "    cmd: echo",
        "    vars:",
        "      X:",
        '        raw: "$(date)"',
        "",
      ],
      "not supported yet",
    );
  });

  test("rejects step-object `cmds[].task` entry with remediation (not silent schema error)", async () => {
    await assertRejectsLandofile(
      ["name: myapp", "tooling:", "  build:", "    cmds:", "      - task: assets", ""],
      "not supported yet",
    );
  });

  test("rejects step-object `cmds[].command` entry with remediation", async () => {
    await assertRejectsLandofile(
      ["name: myapp", "tooling:", "  build:", "    cmds:", "      - command: app:start", ""],
      "not supported yet",
    );
  });
});
