import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, type ServiceConfig, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import type { ServiceType } from "@lando/sdk/services";

import {
  PYTHON_FEATURE_ID,
  SUPPORTED_PYTHON_FRAMEWORKS,
  SUPPORTED_PYTHON_VERSIONS,
  python312ServiceType,
  pythonServiceFeature,
} from "../src/services/python.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-05-17T22:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const APP_ROOT = "/srv/apps/myapp";
const featureOverrides = new Map([[PYTHON_FEATURE_ID, pythonServiceFeature]]);

const decodeService = (raw: unknown): ServiceConfig => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { web: raw },
  });
  const service = landofile.services?.[ServiceName.make("web")];
  if (service === undefined) throw new Error("web service missing");
  return service;
};

const composePythonPlan = (
  serviceType: ServiceType,
  raw: unknown,
  appRoot = APP_ROOT,
): Promise<ServicePlan> =>
  composeServicePlan({
    serviceType,
    service: decodeService(raw),
    appRoot,
    appName: "myapp",
    serviceName: "web",
    metadata,
    featureOverrides,
  });

const expectRejectsToThrow = async (promise: Promise<unknown>, pattern: RegExp): Promise<void> => {
  let rejected = false;
  await promise.then(
    () => undefined,
    (error: unknown) => {
      rejected = true;
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(pattern);
    },
  );
  expect(rejected).toBe(true);
};

describe("python ServiceType — supported versions and frameworks", () => {
  test("exposes 3.12 as the alpha supported python version", () => {
    expect([...SUPPORTED_PYTHON_VERSIONS]).toEqual(["3.12"]);
  });

  test("exposes django, fastapi, flask, none as supported frameworks", () => {
    expect([...SUPPORTED_PYTHON_FRAMEWORKS]).toEqual(["django", "fastapi", "flask", "none"]);
  });
});

describe("python:3.12 ServiceType", () => {
  test("plans a default Python 3.12 web service with framework=none defaults", async () => {
    const plan = await composePythonPlan(python312ServiceType, { type: "python:3.12" });

    expect(plan.type).toBe("python:3.12");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "python:3.12-slim" });
    expect(plan.primary).toBe(true);
    expect(plan.command).toEqual(["sh", "-c", "tail -f /dev/null"]);
    expect(String(plan.workingDirectory)).toBe("/app");

    expect(String(plan.appMount?.source)).toBe(APP_ROOT);
    expect(String(plan.appMount?.target)).toBe("/app");
    expect(plan.appMount?.readOnly).toBe(false);
    expect(plan.appMount?.excludes).toContain("__pycache__");

    expect(plan.mounts).toHaveLength(1);
    expect(plan.mounts[0]?.type).toBe("bind");
    expect(plan.mounts[0]?.source).toBe(APP_ROOT);
    expect(String(plan.mounts[0]?.target)).toBe("/app");

    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 8000, protocol: "http", name: "web" }]);

    expect(plan.healthcheck).toEqual({
      kind: "command",
      command: ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8000"],
      intervalSeconds: 10,
      timeoutSeconds: 5,
      retries: 5,
      startPeriodSeconds: 10,
    });

    expect(plan.environment).toMatchObject({
      LANDO: "ON",
      LANDO_APP_NAME: "myapp",
      LANDO_APP_KIND: "user",
      LANDO_APP_ROOT: "/app",
      LANDO_PROJECT: "myapp",
      LANDO_PROJECT_MOUNT: "/app",
      LANDO_SERVICE_API: "4",
      LANDO_SERVICE_NAME: "web",
      LANDO_SERVICE_TYPE: "python:3.12",
      PYTHONUNBUFFERED: "1",
      PYTHONDONTWRITEBYTECODE: "1",
    });

    expect(plan.extensions["lando-service-python"]).toEqual({
      framework: "none",
      version: "3.12",
      defaultCommand: null,
      port: 8000,
    });
  });

  test("framework=django sets port 8000, uvicorn default command preset, and django env", async () => {
    const plan = await composePythonPlan(python312ServiceType, { type: "python:3.12", framework: "django" });

    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 8000, protocol: "http", name: "web" }]);
    expect(plan.healthcheck?.command).toEqual(["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8000"]);
    expect(plan.command).toEqual(["sh", "-c", "tail -f /dev/null"]);
    expect(plan.extensions["lando-service-python"]).toMatchObject({
      framework: "django",
      port: 8000,
      defaultCommand: ["uvicorn", "--host", "0.0.0.0", "--port", "8000"],
    });
    expect(plan.environment.DJANGO_SETTINGS_MODULE).toBe("config.settings");
  });

  test("framework=fastapi sets port 8000 and uvicorn default command preset", async () => {
    const plan = await composePythonPlan(python312ServiceType, { type: "python:3.12", framework: "fastapi" });

    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 8000, protocol: "http", name: "web" }]);
    expect(plan.healthcheck?.command).toEqual(["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8000"]);
    expect(plan.command).toEqual(["sh", "-c", "tail -f /dev/null"]);
    expect(plan.extensions["lando-service-python"]).toMatchObject({
      framework: "fastapi",
      port: 8000,
      defaultCommand: ["uvicorn", "--host", "0.0.0.0", "--port", "8000"],
    });
  });

  test("framework=flask sets port 5000 and gunicorn default command preset", async () => {
    const plan = await composePythonPlan(python312ServiceType, { type: "python:3.12", framework: "flask" });

    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 5000, protocol: "http", name: "web" }]);
    expect(plan.healthcheck?.command).toEqual(["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/5000"]);
    expect(plan.command).toEqual(["sh", "-c", "tail -f /dev/null"]);
    expect(plan.extensions["lando-service-python"]).toMatchObject({
      framework: "flask",
      port: 5000,
      defaultCommand: ["gunicorn", "--bind", "0.0.0.0:5000"],
    });
    expect(plan.environment.FLASK_APP).toBe("app");
  });

  test("derives appName from appRoot basename when no explicit appName is provided", async () => {
    const plan = await composeServicePlan({
      serviceType: python312ServiceType,
      service: decodeService({ type: "python:3.12" }),
      appRoot: "/srv/apps/anotherapp",
      serviceName: "web",
      metadata,
      featureOverrides,
    });

    expect(plan.environment.LANDO_APP_NAME).toBe("anotherapp");
    expect(plan.environment.LANDO_PROJECT).toBe("anotherapp");
  });

  test("user environment overrides framework defaults but cannot override LANDO_*", async () => {
    const plan = await composePythonPlan(python312ServiceType, {
      type: "python:3.12",
      framework: "django",
      environment: { DJANGO_SETTINGS_MODULE: "myproject.settings.dev", FOO: "bar" },
    });

    expect(plan.environment.DJANGO_SETTINGS_MODULE).toBe("myproject.settings.dev");
    expect(plan.environment.FOO).toBe("bar");
    expect(plan.environment.LANDO_PROJECT).toBe("myapp");
  });

  test("propagates user image override and custom port", async () => {
    const plan = await composePythonPlan(python312ServiceType, {
      type: "python:3.12",
      image: "registry.example.com/python:3.12-custom",
      port: 9000,
    });

    expect(plan.artifact).toEqual({ kind: "ref", ref: "registry.example.com/python:3.12-custom" });
    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 9000, protocol: "http", name: "web" }]);
    expect(plan.healthcheck?.command).toEqual(["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/9000"]);
    expect(plan.extensions["lando-service-python"]).toMatchObject({ port: 9000 });
  });

  test("rejects unsupported framework values with remediation", async () => {
    await expectRejectsToThrow(
      composePythonPlan(python312ServiceType, { type: "python:3.12", framework: "rails" }),
      /Unsupported Python framework "rails"\./,
    );

    await expectRejectsToThrow(
      composePythonPlan(python312ServiceType, { type: "python:3.12", framework: "rails" }),
      /Set framework to one of: django, fastapi, flask, none/,
    );
  });

  test("rejects unsupported Python versions with remediation", async () => {
    await expectRejectsToThrow(
      composePythonPlan(python312ServiceType, { type: "python:3.11" }),
      /Unsupported Python version "3.11"\./,
    );

    await expectRejectsToThrow(
      composePythonPlan(python312ServiceType, { type: "python:3.11" }),
      /Set type to one of: python:3.12/,
    );
  });

  test("rejects user environment that targets reserved LANDO_* keys", async () => {
    await expectRejectsToThrow(
      composePythonPlan(python312ServiceType, {
        type: "python:3.12",
        environment: { LANDO_PROJECT: "evil", FOO: "bar" },
      }),
      /reserved LANDO_\* keys.*LANDO_PROJECT/,
    );
  });
});
