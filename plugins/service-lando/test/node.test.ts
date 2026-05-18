import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Either, Exit, ParseResult, Schema } from "effect";

import { LandofileService } from "@lando/core/services";
import { LandofileShape, ServiceConfig, ServiceName } from "@lando/sdk/schema";

import { LandofileServiceLive } from "../../../core/src/landofile/service.ts";
import { node22ServiceType, nodeLtsServiceType } from "../src/services/node.ts";

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
    expect(plan.environment).toMatchObject({ NODE_ENV: "development" });
    expect(plan.endpoints).toEqual([{ port: 3000, protocol: "http", name: "web" }]);
  });

  test("ServiceConfig schema accepts the framework field", () => {
    const result = Schema.decodeUnknownEither(ServiceConfig)(
      { type: "node:lts", framework: "drupal" },
      {
        onExcessProperty: "error",
      },
    );

    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right.framework).toBe("drupal");
    }
  });

  test("LandofileService accepts the framework field on services", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        ["name: myapp", "services:", "  web:", "    type: node:lts", "    framework: drupal", ""].join("\n"),
      );
      process.chdir(dir);

      const failure = await discoverExit();

      expect(failure).toBeUndefined();
    });
  });

  test("node:lts ServiceType ignores framework but never crashes", () => {
    const service = Schema.decodeUnknownSync(ServiceConfig)({
      type: "node:lts",
      framework: "drupal",
    });

    const plan = nodeLtsServiceType.toServicePlan({
      name: "web",
      service,
      appRoot: "/srv/apps/myapp",
      metadata,
    });

    expect(plan.type).toBe("node:lts");
    expect("framework" in plan).toBe(false);
  });

  test("ServiceConfig still rejects unknown excess keys via strict decoding", () => {
    const result = Schema.decodeUnknownEither(ServiceConfig)(
      { type: "node:lts", nonsenseKey: "value" },
      { onExcessProperty: "error" },
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(ParseResult.isParseError(result.left)).toBe(true);
      const issues = ParseResult.ArrayFormatter.formatErrorSync(result.left);
      expect(issues.some((issue) => issue.path.includes("nonsenseKey"))).toBe(true);
    }
  });

  test("plan is a valid providerExec target: long-running command + app workdir", () => {
    const service = Schema.decodeUnknownSync(ServiceConfig)({ type: "node:lts" });
    const plan = nodeLtsServiceType.toServicePlan({
      name: "web",
      service,
      appRoot: "/srv/apps/myapp",
      metadata,
    });

    expect(plan.command).toEqual(["sh", "-c", "tail -f /dev/null"]);
    expect(plan.name).toBe(ServiceName.make("web"));
    expect(String(plan.workingDirectory)).toBe("/app");
    expect(String(plan.appMount?.target)).toBe("/app");
  });
});

describe("node:22 ServiceType", () => {
  test("plans a default Node 22 service", () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { web: { type: "node:22" } },
    });
    const service = landofile.services?.[ServiceName.make("web")];
    if (service === undefined) throw new Error("web service missing");

    const plan = node22ServiceType.toServicePlan({
      name: "web",
      service,
      appRoot: "/srv/apps/myapp",
      metadata,
    });

    expect(plan.type).toBe("node:22");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "node:22" });
    expect(String(plan.workingDirectory)).toBe("/app");
    expect(String(plan.appMount?.source)).toBe("/srv/apps/myapp");
    expect(String(plan.appMount?.target)).toBe("/app");
    expect(plan.appMount?.readOnly).toBe(false);
    expect(plan.mounts[0]?.type).toBe("bind");
    expect(plan.mounts[0]?.source).toBe("/srv/apps/myapp");
    expect(String(plan.mounts[0]?.target)).toBe("/app");
    expect(plan.mounts[0]?.realization).toBe("passthrough");
    expect(plan.command).toEqual(["sh", "-c", "tail -f /dev/null"]);
    expect(plan.endpoints).toEqual([{ port: 3000, protocol: "http", name: "web" }]);
  });

  test("propagates user overrides including custom image and ports", () => {
    const service = Schema.decodeUnknownSync(ServiceConfig)({
      type: "node:22",
      image: "node:22-alpine",
      command: "npm run dev",
      environment: { NODE_ENV: "development" },
      ports: ["3001:3000"],
    });

    const plan = node22ServiceType.toServicePlan({
      name: "web",
      service,
      appRoot: "/srv/apps/myapp",
      metadata,
    });

    expect(plan.type).toBe("node:22");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "node:22-alpine" });
    expect(plan.command).toBe("npm run dev");
    expect(plan.environment).toMatchObject({ NODE_ENV: "development" });
    expect(plan.endpoints).toEqual([{ port: 3000, protocol: "http", name: "web" }]);
  });

  test("rejects unsupported node versions with remediation", () => {
    const service = Schema.decodeUnknownSync(ServiceConfig)({ type: "node:18" });
    expect(() =>
      node22ServiceType.toServicePlan({
        name: "web",
        service,
        appRoot: "/srv/apps/myapp",
        metadata,
      }),
    ).toThrow(/Unsupported Node version "18".*Set type to one of: node:lts, node:22/);
  });

  test("plan is a valid providerExec target: long-running command + app workdir", () => {
    const service = Schema.decodeUnknownSync(ServiceConfig)({ type: "node:22" });
    const plan = node22ServiceType.toServicePlan({
      name: "web",
      service,
      appRoot: "/srv/apps/myapp",
      metadata,
    });

    expect(plan.command).toEqual(["sh", "-c", "tail -f /dev/null"]);
    expect(plan.name).toBe(ServiceName.make("web"));
    expect(String(plan.workingDirectory)).toBe("/app");
    expect(String(plan.appMount?.target)).toBe("/app");
  });
});
