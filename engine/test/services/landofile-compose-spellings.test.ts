import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";

import { LandofileValidationError } from "@lando/sdk/errors";
import { PortablePath, ServiceName } from "@lando/sdk/schema";
import { LandofileService } from "@lando/sdk/services";
import { LandofileServiceLive } from "../../src/services/landofile-live";

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-compose-spellings-"));
  const previousCwd = process.cwd();
  try {
    return await run(dir);
  } finally {
    process.chdir(previousCwd);
    await rm(dir, { recursive: true, force: true });
  }
};

const discoverExit = () =>
  Effect.runPromiseExit(
    Effect.flatMap(LandofileService, (landofileService) => landofileService.discover).pipe(
      Effect.provide(LandofileServiceLive),
    ),
  );

const write = (dir: string, body: string) => writeFile(join(dir, ".lando.yml"), body);

describe("LandofileServiceLive — Compose service spellings", () => {
  test("canonicalizes working_dir, depends_on map, environment list, and labels list", async () => {
    await withTempCwd(async (dir) => {
      await write(
        dir,
        [
          "name: composeapp",
          "runtime: 4",
          "services:",
          "  web:",
          "    image: node:lts",
          "    working_dir: /app",
          "    depends_on:",
          "      database:",
          "        condition: service_healthy",
          "        restart: true",
          "    environment:",
          "      - NODE_ENV=development",
          "    labels:",
          "      - com.example.tier=web",
          "  database:",
          "    image: postgres:16",
          "",
        ].join("\n"),
      );
      process.chdir(dir);

      const exit = await discoverExit();
      expect(Exit.isSuccess(exit)).toBe(true);
      if (!Exit.isSuccess(exit)) return;
      const web = exit.value.services?.[ServiceName.make("web")];
      expect(web?.workingDirectory).toBe(PortablePath.make("/app"));
      expect(web?.dependsOn).toEqual([{ service: "database", condition: "service_healthy", restart: true }]);
      expect(web?.environment).toEqual({ NODE_ENV: "development" });
      expect(web?.labels).toEqual({ "com.example.tier": "web" });
    });
  });

  test("bare environment list entry fails with KEY=value remediation", async () => {
    await withTempCwd(async (dir) => {
      await write(
        dir,
        [
          "name: composeapp",
          "runtime: 4",
          "services:",
          "  web:",
          "    image: node:lts",
          "    environment:",
          "      - NODE_ENV",
          "",
        ].join("\n"),
      );
      process.chdir(dir);

      const exit = await discoverExit();
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) return;
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag !== "Some") return;
      expect(failure.value).toBeInstanceOf(LandofileValidationError);
      expect((failure.value as LandofileValidationError).message).toContain("KEY=value");
    });
  });

  test("canonicalizes Compose healthchecks through both Landofile decode passes", async () => {
    await withTempCwd(async (dir) => {
      // Given
      await write(
        dir,
        [
          "name: composeapp",
          "runtime: 4",
          "services:",
          "  disabled:",
          "    image: node:lts",
          "    healthcheck:",
          "      disable: true",
          "  none:",
          "    image: node:lts",
          "    healthcheck:",
          "      test:",
          "        - NONE",
          "  mixed:",
          "    image: node:lts",
          "    healthcheck:",
          "      command:",
          "        - echo",
          "        - lando",
          "      disable: true",
          "      test:",
          "        - NONE",
          "      interval: 30s",
          "      intervalSeconds: 12",
          '      retries: "3"',
          "      start_interval: 5s",
          "",
        ].join("\n"),
      );
      process.chdir(dir);

      // When
      const exit = await discoverExit();

      // Then
      expect(Exit.isSuccess(exit)).toBe(true);
      if (!Exit.isSuccess(exit)) return;
      expect(exit.value.services?.[ServiceName.make("disabled")]?.healthcheck).toEqual({
        kind: "none",
      });
      expect(exit.value.services?.[ServiceName.make("none")]?.healthcheck).toEqual({
        kind: "none",
      });
      expect(exit.value.services?.[ServiceName.make("mixed")]?.healthcheck).toEqual({
        kind: "command",
        command: ["echo", "lando"],
        intervalSeconds: 12,
        retries: 3,
        startInterval: "5s",
      });
    });
  });

  test("reports remediation for an invalid Compose healthcheck duration", async () => {
    await withTempCwd(async (dir) => {
      // Given
      await write(
        dir,
        [
          "name: composeapp",
          "runtime: 4",
          "services:",
          "  web:",
          "    image: node:lts",
          "    healthcheck:",
          "      test:",
          "        - CMD",
          '        - "true"',
          "      interval: 30 seconds",
          "",
        ].join("\n"),
      );
      process.chdir(dir);

      // When
      const exit = await discoverExit();

      // Then
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) return;
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag !== "Some") return;
      expect(failure.value).toBeInstanceOf(LandofileValidationError);
      if (!(failure.value instanceof LandofileValidationError)) return;
      expect(failure.value.issues).toContain("services.web.healthcheck");
      const issues = failure.value.issues.join("\n");
      expect(issues).toContain("Compose duration");
      expect(issues).toContain("30s");
      expect(issues).toContain("1m30s");
      expect(issues).toContain("1h2m3s");
    });
  });
});
