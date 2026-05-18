import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";

import {
  LandofileNotFoundError,
  LandofileParseError,
  LandofileValidationError,
  NotImplementedError,
} from "@lando/core/errors";
import { ServiceName } from "@lando/core/schema";
import { LandofileService } from "@lando/core/services";
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
            expect(error.message).toContain("spec/07-landofile-and-config.md");
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
      expect(web?.appMount?.target).toBe("/app");
      expect(web?.appMount?.excludes).toEqual(["node_modules", "vendor"]);
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
  const assertBetaRejection = (error: unknown, expectedSpecSection: string): void => {
    expect(error).toBeInstanceOf(NotImplementedError);
    if (!(error instanceof NotImplementedError)) return;
    expect(error._tag).toBe("NotImplementedError");
    expect(error.specSection).toBe(expectedSpecSection);
    expect(error.remediation.toLowerCase()).toContain("beta");
  };

  test("rejects top-level `includes:` with NotImplementedError + Beta remediation", async () => {
    await withTempCwd(async (dir) => {
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
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") assertBetaRejection(failure.value, "§7.7");
      }
    });
  });

  test("rejects configuration expressions ${...} with NotImplementedError + Beta remediation", async () => {
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
        if (failure._tag === "Some") assertBetaRejection(failure.value, "§7.3.1");
      }
    });
  });

  test("rejects top-level `secrets:` with NotImplementedError + Beta remediation", async () => {
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
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") assertBetaRejection(failure.value, "§4.2/§7.4");
      }
    });
  });

  test("rejects top-level `env_file:` env overrides with NotImplementedError + Beta remediation", async () => {
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
        if (failure._tag === "Some") assertBetaRejection(failure.value, "§7.6");
      }
    });
  });
});
