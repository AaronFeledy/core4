import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Cause, Effect, Exit, Option, Result } from "effect";

import { globalAppRootPath } from "@lando/paths";
import type { PluginDoctorCheckInput } from "@lando/sdk/plugins";
import { AppId, type HostPlatform } from "@lando/sdk/schema";

import { legacyRouteFilesCheck } from "../src/doctor-legacy-routes.ts";
import { dynamicConfigDir } from "../src/proxy-paths.ts";
import { renderRouteFileMetadata } from "../src/route-file-metadata.ts";
import { legacyContent, legacyName } from "./legacy-route-fixture.ts";

const platform: HostPlatform = process.platform === "win32" ? "win32" : "linux";
const ownerKey = "cd".repeat(32);

const doctorInput = (userDataRoot: string | undefined): PluginDoctorCheckInput => ({
  providerId: "lando",
  platform,
  env: {},
  userDataRoot,
  binDir: undefined,
  stateDir: undefined,
});

const withUserData = async <T>(run: (userDataRoot: string) => Promise<T>): Promise<T> => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "lando-legacy-routes-"));
  try {
    return await run(userDataRoot);
  } finally {
    await rm(userDataRoot, { recursive: true, force: true });
  }
};

const dynamicDir = (userDataRoot: string) =>
  dynamicConfigDir({ platform, globalAppRoot: globalAppRootPath(userDataRoot, platform) });

describe("legacy route files doctor check", () => {
  test("exports id legacy-route-files with no relevant predicate", () => {
    expect(legacyRouteFilesCheck.id).toBe("legacy-route-files");
    expect(legacyRouteFilesCheck.relevant).toBeUndefined();
  });

  test("returns empty when userDataRoot is undefined", async () => {
    const reports = await Effect.runPromise(legacyRouteFilesCheck.run(doctorInput(undefined)));
    expect(reports).toEqual([]);
  });

  test("warns read-only for slug-named routes files and names them", async () => {
    await withUserData(async (userDataRoot) => {
      const directory = dynamicDir(userDataRoot);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "routes-old-slug.yml"), "http:\n  routers: {}\n", "utf8");
      await writeFile(join(directory, "fallback.yml"), "http:\n", "utf8");

      const reports = await Effect.runPromise(legacyRouteFilesCheck.run(doctorInput(userDataRoot)));

      expect(reports).toHaveLength(1);
      const report = reports[0];
      expect(report).toBeDefined();
      if (report === undefined) return;
      expect(report.name).toBe("legacy-route-files");
      expect(report.status).toBe("warn");
      expect(report.severity).toBe("warn");
      expect(report.runtimeStatus).toBe("legacy-route-files");
      expect(report.runtime).toBeUndefined();
      expect(report.context).toEqual({
        proxyId: "traefik",
        unrecognizedCount: "1",
        unrecognizedFiles: join(directory, "routes-old-slug.yml"),
      });
      expect(report.solutions).toHaveLength(1);
      expect(report.solutions.every((solution) => solution.kind === "manual")).toBe(true);
      expect(report.solutions.flatMap((solution) => solution.command ?? [])).toEqual(
        platform === "win32" ? ["lando global:restart"] : [],
      );
      expect(await readFile(join(directory, "routes-old-slug.yml"), "utf8")).toBe("http:\n  routers: {}\n");
    });
  });

  test.each([false, true])("classifies recognized generated files read-only (mixed: %s)", async (mixed) => {
    await withUserData(async (userDataRoot) => {
      const directory = dynamicDir(userDataRoot);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, legacyName), legacyContent);
      if (mixed) await writeFile(join(directory, "routes-custom.yml"), "custom configuration");

      const reports = await Effect.runPromise(legacyRouteFilesCheck.run(doctorInput(userDataRoot)));

      expect(reports).toHaveLength(1);
      expect(reports[0]?.context.generatedCount).toBe("1");
      expect(reports[0]?.context.unrecognizedCount).toBe(mixed ? "1" : undefined);
      expect(reports[0]?.context.generatedFiles).toBe(join(directory, legacyName));
      expect(reports[0]?.context.unrecognizedFiles).toBe(
        mixed ? join(directory, "routes-custom.yml") : undefined,
      );
      expect(reports[0]?.severity).toBe(mixed ? "warn" : "info");
      expect(reports[0]?.solutions).toHaveLength(mixed ? 2 : 1);
      expect(reports[0]?.solutions[0]?.command).toBe("lando setup");
      expect(reports[0]?.solutions.every((solution) => solution.kind === "manual")).toBe(true);
      expect(await readFile(join(directory, legacyName), "utf8")).toBe(legacyContent);
    });
  });

  test("warns for hex-named files that lack valid metadata", async () => {
    await withUserData(async (userDataRoot) => {
      const directory = dynamicDir(userDataRoot);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, `routes-${ownerKey}.yml`), "http:\n  routers: {}\n", "utf8");

      const reports = await Effect.runPromise(legacyRouteFilesCheck.run(doctorInput(userDataRoot)));

      expect(reports).toHaveLength(1);
      expect(reports[0]?.context.unrecognizedFiles).toBe(join(directory, `routes-${ownerKey}.yml`));
      expect(reports[0]?.status).toBe("warn");
    });
  });

  test("stays quiet for full owner-layout files with valid metadata", async () => {
    await withUserData(async (userDataRoot) => {
      const directory = dynamicDir(userDataRoot);
      await mkdir(directory, { recursive: true });
      const content = `${renderRouteFileMetadata(AppId.make("demo"))}\nhttp:\n  routers: {}\n`;
      await writeFile(join(directory, `routes-${ownerKey}.yml`), content, "utf8");

      const reports = await Effect.runPromise(legacyRouteFilesCheck.run(doctorInput(userDataRoot)));
      expect(reports).toEqual([]);
    });
  });

  test("names every legacy file when several are present", async () => {
    await withUserData(async (userDataRoot) => {
      const directory = dynamicDir(userDataRoot);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "routes-a.yml"), "http:\n", "utf8");
      await writeFile(join(directory, "routes-b.yml"), "http:\n", "utf8");
      const good = `${renderRouteFileMetadata(AppId.make("kept"))}\nhttp:\n`;
      await writeFile(join(directory, `routes-${ownerKey}.yml`), good, "utf8");

      const reports = await Effect.runPromise(legacyRouteFilesCheck.run(doctorInput(userDataRoot)));
      expect(reports[0]?.context.unrecognizedCount).toBe("2");
      expect(reports[0]?.context.unrecognizedFiles).toBe(
        [join(directory, "routes-a.yml"), join(directory, "routes-b.yml")].join(", "),
      );
    });
  });

  test("treats a missing dynamic directory as absence", async () => {
    await withUserData(async (userDataRoot) => {
      expect(await Effect.runPromise(legacyRouteFilesCheck.run(doctorInput(userDataRoot)))).toEqual([]);
    });
  });

  test("ignores a candidate that resolves to ENOENT", async () => {
    await withUserData(async (userDataRoot) => {
      const directory = dynamicDir(userDataRoot);
      await mkdir(directory, { recursive: true });
      await symlink(join(directory, "missing.yml"), join(directory, `routes-${ownerKey}.yml`), "file");

      expect(await Effect.runPromise(legacyRouteFilesCheck.run(doctorInput(userDataRoot)))).toEqual([]);
    });
  });

  test.each([
    { target: "directory", code: "ENOTDIR" },
    { target: "file", code: "EISDIR" },
  ] as const)("surfaces a non-ENOENT $target inspection failure as a defect", async ({ target, code }) => {
    await withUserData(async (userDataRoot) => {
      const directory = dynamicDir(userDataRoot);
      switch (target) {
        case "directory":
          await mkdir(dirname(directory), { recursive: true });
          await writeFile(directory, "not a directory");
          break;
        case "file":
          await mkdir(join(directory, `routes-${ownerKey}.yml`), { recursive: true });
          break;
        default:
          target satisfies never;
      }

      const exit = await Effect.runPromiseExit(legacyRouteFilesCheck.run(doctorInput(userDataRoot)));
      const defect = Exit.match(exit, {
        onSuccess: () => undefined,
        onFailure: (cause) => Option.getOrUndefined(Result.getSuccess(Cause.findDefect(cause))),
      });

      expect(defect).toMatchObject({ code });
    });
  });

  test.each([false, true])(
    "bounds whole-path evidence while keeping complete counts (generated: %s)",
    async (generated) => {
      await withUserData(async (userDataRoot) => {
        const directory = dynamicDir(userDataRoot);
        await mkdir(directory, { recursive: true });
        const files = Array.from({ length: 12 }, (_, index) =>
          join(directory, `routes-${String(index).padStart(2, "0")}-${"x".repeat(180)}.yml`),
        );
        for (const file of files) {
          const encoded = file.slice(file.lastIndexOf("routes-") + "routes-".length, -".yml".length);
          await writeFile(
            file,
            generated ? legacyContent.replaceAll("old%2Fapp", encoded) : "legacy configuration",
          );
        }

        const reports = await Effect.runPromise(legacyRouteFilesCheck.run(doctorInput(userDataRoot)));

        const first = files[0];
        if (first === undefined) throw new Error("legacy file fixture missing");
        const count = Math.floor((2_000 + 2) / (first.length + 2));
        const key = generated ? "generated" : "unrecognized";
        expect(reports[0]?.context[`${key}Files`]?.split(", ")).toEqual(files.slice(0, count));
        expect(reports[0]?.context[`${key}FilesTruncated`]).toBe("true");
        expect(reports[0]?.context[`${key}Count`]).toBe("12");
        expect(reports[0]?.context[generated ? "unrecognizedCount" : "generatedCount"]).toBeUndefined();
      });
    },
  );
});
