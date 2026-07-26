import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";

import { LandofileValidationError } from "@lando/core/errors";
import { ServiceName } from "@lando/core/schema";
import { LandofileService } from "@lando/core/services";
import { LandofileServiceLive } from "../../src/landofile/service.ts";

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
      expect(web?.workingDirectory).toBe("/app");
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
});
