import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LandofileShape, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import type { ServiceType } from "@lando/sdk/services";
import { Schema } from "effect";
import { PHP_FEATURE_ID, php84ServiceType, phpServiceFeature } from "../src/services/php.ts";
import {
  PHP_CREATE_PROJECT_PATH,
  PHP_CREATE_PROJECT_SCRIPT,
  PHP_CREATE_PROJECT_STEP_ID,
  phpCreateProjectBuildStep,
  phpCreateProjectCommand,
} from "../src/services/php-create-project.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const BuildSteps = Schema.Struct({
  buildSteps: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.optionalKey(Schema.String),
        command: Schema.Unknown,
        user: Schema.optionalKey(Schema.String),
        buildKeyInputs: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
      }),
    ),
  ),
});

const composePhpPlan = (
  overrides: Record<string, unknown> = {},
  serviceType: ServiceType = php84ServiceType,
): Promise<ServicePlan> => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "php-create-project",
    services: { web: { type: serviceType.id, ...overrides } },
  });
  const service = landofile.services?.[ServiceName.make("web")];
  if (service === undefined) throw new Error("web service missing");
  return composeServicePlan({
    serviceType,
    service,
    appRoot: "/srv/apps/php-create-project",
    appName: "php-create-project",
    serviceName: "web",
    metadata: {
      resolvedAt: "2026-11-16T00:00:00Z",
      source: "/srv/apps/php-create-project/.lando.yml",
      runtime: 4,
    },
    featureOverrides: new Map([[PHP_FEATURE_ID, phpServiceFeature]]),
  });
};

const buildStepsFor = (plan: ServicePlan) =>
  Schema.decodeUnknownSync(BuildSteps)(plan.extensions["@lando/core/service-features"]).buildSteps ?? [];

const createProjectStep = (plan: ServicePlan) =>
  buildStepsFor(plan).find((step) => step.id === PHP_CREATE_PROJECT_STEP_ID);

describe("PHP create-project image step", () => {
  test("installs the shared program as an executable when Composer is enabled", async () => {
    const plan = await composePhpPlan();

    const step = createProjectStep(plan);

    expect(step).toBeDefined();
    expect(PHP_CREATE_PROJECT_PATH.startsWith("/usr/local/bin/")).toBe(true);
    expect(step?.user).toBe("root");
    expect(typeof step?.command).toBe("string");
    expect(step?.command as string).toContain(
      `> ${PHP_CREATE_PROJECT_PATH} && chmod 0755 ${PHP_CREATE_PROJECT_PATH}`,
    );
    expect(step?.buildKeyInputs?.createProject).toEqual({
      path: PHP_CREATE_PROJECT_PATH,
      content: PHP_CREATE_PROJECT_SCRIPT,
    });
  });

  test("is absent when Composer is disabled", async () => {
    const plan = await composePhpPlan({ composer: false });

    expect(createProjectStep(plan)).toBeUndefined();
  });

  test("carries the generated program verbatim as a shebang script", () => {
    expect(PHP_CREATE_PROJECT_SCRIPT.startsWith("#!/bin/sh\n")).toBe(true);
    expect(PHP_CREATE_PROJECT_SCRIPT).toContain(".lando-create-project-lock");
    expect(PHP_CREATE_PROJECT_SCRIPT).toContain("composer install --no-interaction");
    expect(PHP_CREATE_PROJECT_SCRIPT.endsWith("\n")).toBe(true);
    expect(phpCreateProjectBuildStep().buildKeyInputs).toEqual({
      createProject: { path: PHP_CREATE_PROJECT_PATH, content: PHP_CREATE_PROJECT_SCRIPT },
    });
  });

  test("build command writes byte-identical, world-executable output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-php-create-project-"));
    try {
      const path = join(dir, "lando-create-project");
      const proc = Bun.spawn({
        cmd: ["sh", "-c", phpCreateProjectCommand(PHP_CREATE_PROJECT_SCRIPT, path)],
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(await readFile(path, "utf8")).toBe(PHP_CREATE_PROJECT_SCRIPT);
      expect((await stat(path)).mode & 0o777).toBe(0o755);

      const syntax = Bun.spawn({ cmd: ["sh", "-n", path], stdout: "pipe", stderr: "pipe" });
      expect(await syntax.exited).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
