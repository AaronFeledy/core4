import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Either, Exit, ParseResult, Schema } from "effect";

import { LandofileService } from "@lando/core/services";
import { LandofileShape, ServiceConfig, ServiceName } from "@lando/sdk/schema";

import { LandofileServiceLive } from "../../../core/src/landofile/service.ts";
import { nodeLtsServiceType } from "../src/services/node.ts";

const metadata = {
  resolvedAt: "2026-05-15T08:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const discoverExit = async () => {
  const exit = await Effect.runPromiseExit(
    Effect.flatMap(LandofileService, (landofileService) => landofileService.discover).pipe(
      Effect.provide(LandofileServiceLive),
    ),
  );
  if (Exit.isSuccess(exit)) return undefined;
  const failure = Cause.failureOption(exit.cause);
  return failure._tag === "Some" ? failure.value : undefined;
};

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-node-service-type-")));
  const previousCwd = process.cwd();
  try {
    return await run(dir);
  } finally {
    process.chdir(previousCwd);
    await rm(dir, { recursive: true, force: true });
  }
};

describe("node:lts ServiceType", () => {
  test("plans a default Node LTS service", () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { web: { type: "node:lts" } },
    });
    const service = landofile.services?.[ServiceName.make("web")];
    if (service === undefined) throw new Error("web service missing");

    const plan = nodeLtsServiceType.toServicePlan({
      name: "web",
      service,
      appRoot: "/srv/apps/myapp",
      metadata,
    });

    expect(plan.type).toBe("node:lts");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "node:lts" });
    expect(String(plan.workingDirectory)).toBe("/app");
    expect(String(plan.appMount?.source)).toBe("/srv/apps/myapp");
    expect(String(plan.appMount?.target)).toBe("/app");
    expect(plan.appMount?.readOnly).toBe(false);
    expect(plan.mounts[0]?.type).toBe("bind");
    expect(plan.mounts[0]?.source).toBe("/srv/apps/myapp");
    expect(String(plan.mounts[0]?.target)).toBe("/app");
    expect(plan.mounts[0]?.readOnly).toBe(false);
    expect(plan.mounts[0]?.realization).toBe("passthrough");
    expect(plan.command).toEqual(["sh", "-c", "tail -f /dev/null"]);
    expect(plan.endpoints).toEqual([{ port: 3000, protocol: "http", name: "web" }]);
  });

  test("propagates user overrides", () => {
    const service = Schema.decodeUnknownSync(ServiceConfig)({
      type: "node:lts",
      image: "node:22",
      command: "npm start",
      environment: { NODE_ENV: "development" },
      ports: ["3001:3000"],
    });

    const plan = nodeLtsServiceType.toServicePlan({
      name: "web",
      service,
      appRoot: "/srv/apps/myapp",
      metadata,
    });

    expect(plan.artifact).toEqual({ kind: "ref", ref: "node:22" });
    expect(plan.command).toBe("npm start");
    expect(plan.environment).toEqual({ NODE_ENV: "development" });
    expect(plan.endpoints).toEqual([{ port: 3000, protocol: "http", name: "web" }]);
  });

  test("rejects framework presets at MVP", () => {
    const result = Schema.decodeUnknownEither(ServiceConfig)(
      { type: "node:lts", framework: "drupal" },
      {
        onExcessProperty: "error",
      },
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(ParseResult.isParseError(result.left)).toBe(true);
      const issues = ParseResult.ArrayFormatter.formatErrorSync(result.left);
      expect(issues.some((issue) => issue.path.includes("framework"))).toBe(true);
    }
  });

  test("LandofileService rejects framework presets at MVP", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        ["name: myapp", "services:", "  web:", "    type: node:lts", "    framework: drupal", ""].join("\n"),
      );
      process.chdir(dir);

      const failure = await discoverExit();

      expect(failure?._tag).toBe("LandofileValidationError");
      if (failure?._tag === "LandofileValidationError") {
        expect(failure.issues).toContain("services.web.framework");
      }
    });
  });
});
