import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, type ServiceConfig, ServiceName } from "@lando/sdk/schema";

import {
  SUPPORTED_PYTHON_FRAMEWORKS,
  SUPPORTED_PYTHON_VERSIONS,
  python312ServiceType,
} from "../src/services/python.ts";

const metadata = {
  resolvedAt: "2026-05-17T22:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const APP_ROOT = "/srv/apps/myapp";

const decodeService = (raw: unknown): ServiceConfig => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { web: raw },
  });
  const service = landofile.services?.[ServiceName.make("web")];
  if (service === undefined) throw new Error("web service missing");
  return service;
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
  test("plans a default Python 3.12 web service with framework=none defaults", () => {
    const service = decodeService({ type: "python:3.12" });
    const plan = python312ServiceType.toServicePlan({
      name: "web",
      service,
      appRoot: APP_ROOT,
      appName: "myapp",
      metadata,
    });

    expect(plan.type).toBe("python:3.12");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "python:3.12-slim" });
    expect(plan.primary).toBe(true);
    expect(String(plan.workingDirectory)).toBe("/app");

    expect(String(plan.appMount?.source)).toBe(APP_ROOT);
    expect(String(plan.appMount?.target)).toBe("/app");
    expect(plan.appMount?.readOnly).toBe(false);

    expect(plan.mounts).toHaveLength(1);
    expect(plan.mounts[0]?.type).toBe("bind");
    expect(plan.mounts[0]?.source).toBe(APP_ROOT);
    expect(String(plan.mounts[0]?.target)).toBe("/app");

    expect(plan.endpoints).toEqual([{ port: 8000, protocol: "http", name: "web" }]);

    expect(plan.healthcheck).toEqual({
      kind: "tcp",
      port: 8000,
      intervalSeconds: 10,
      timeoutSeconds: 5,
      retries: 5,
      startPeriodSeconds: 10,
    });

    expect(plan.environment.LANDO).toBe("ON");
    expect(plan.environment.LANDO_APP_NAME).toBe("myapp");
    expect(plan.environment.LANDO_APP_KIND).toBe("user");
    expect(plan.environment.LANDO_APP_ROOT).toBe("/app");
    expect(plan.environment.LANDO_PROJECT).toBe("myapp");
    expect(plan.environment.LANDO_PROJECT_MOUNT).toBe("/app");
    expect(plan.environment.LANDO_SERVICE_API).toBe("4");
    expect(plan.environment.LANDO_SERVICE_NAME).toBe("web");
    expect(plan.environment.LANDO_SERVICE_TYPE).toBe("python:3.12");

    expect(plan.environment.PYTHONUNBUFFERED).toBe("1");
    expect(plan.environment.PYTHONDONTWRITEBYTECODE).toBe("1");

    expect(plan.extensions["lando-service-python"]).toEqual({
      framework: "none",
      version: "3.12",
      defaultCommand: null,
      port: 8000,
    });
  });

  test("framework=django sets port 8000, uvicorn default command preset, and django env", () => {
    const service = decodeService({ type: "python:3.12", framework: "django" });
    const plan = python312ServiceType.toServicePlan({
      name: "web",
      service,
      appRoot: APP_ROOT,
      appName: "myapp",
      metadata,
    });

    expect(plan.endpoints).toEqual([{ port: 8000, protocol: "http", name: "web" }]);
    expect(plan.healthcheck?.port).toBe(8000);
    expect(plan.extensions["lando-service-python"]).toMatchObject({
      framework: "django",
      port: 8000,
      defaultCommand: ["uvicorn", "--host", "0.0.0.0", "--port", "8000"],
    });
    expect(plan.environment.DJANGO_SETTINGS_MODULE).toBe("config.settings");
  });

  test("framework=fastapi sets port 8000 and uvicorn default command preset", () => {
    const service = decodeService({ type: "python:3.12", framework: "fastapi" });
    const plan = python312ServiceType.toServicePlan({
      name: "web",
      service,
      appRoot: APP_ROOT,
      appName: "myapp",
      metadata,
    });

    expect(plan.endpoints).toEqual([{ port: 8000, protocol: "http", name: "web" }]);
    expect(plan.healthcheck?.port).toBe(8000);
    expect(plan.extensions["lando-service-python"]).toMatchObject({
      framework: "fastapi",
      port: 8000,
      defaultCommand: ["uvicorn", "--host", "0.0.0.0", "--port", "8000"],
    });
  });

  test("framework=flask sets port 5000 and gunicorn default command preset", () => {
    const service = decodeService({ type: "python:3.12", framework: "flask" });
    const plan = python312ServiceType.toServicePlan({
      name: "web",
      service,
      appRoot: APP_ROOT,
      appName: "myapp",
      metadata,
    });

    expect(plan.endpoints).toEqual([{ port: 5000, protocol: "http", name: "web" }]);
    expect(plan.healthcheck?.port).toBe(5000);
    expect(plan.extensions["lando-service-python"]).toMatchObject({
      framework: "flask",
      port: 5000,
      defaultCommand: ["gunicorn", "--bind", "0.0.0.0:5000"],
    });
    expect(plan.environment.FLASK_APP).toBe("app");
  });

  test("derives appName from appRoot basename when no explicit appName is provided", () => {
    const service = decodeService({ type: "python:3.12" });
    const plan = python312ServiceType.toServicePlan({
      name: "web",
      service,
      appRoot: "/srv/apps/anotherapp",
      metadata,
    });
    expect(plan.environment.LANDO_APP_NAME).toBe("anotherapp");
    expect(plan.environment.LANDO_PROJECT).toBe("anotherapp");
  });

  test("user environment overrides framework defaults but cannot override LANDO_*", () => {
    const service = decodeService({
      type: "python:3.12",
      framework: "django",
      environment: { DJANGO_SETTINGS_MODULE: "myproject.settings.dev", FOO: "bar" },
    });
    const plan = python312ServiceType.toServicePlan({
      name: "web",
      service,
      appRoot: APP_ROOT,
      appName: "myapp",
      metadata,
    });

    expect(plan.environment.DJANGO_SETTINGS_MODULE).toBe("myproject.settings.dev");
    expect(plan.environment.FOO).toBe("bar");
    expect(plan.environment.LANDO_PROJECT).toBe("myapp");
  });

  test("propagates user image override and custom port", () => {
    const service = decodeService({
      type: "python:3.12",
      image: "registry.example.com/python:3.12-custom",
      port: 9000,
    });
    const plan = python312ServiceType.toServicePlan({
      name: "web",
      service,
      appRoot: APP_ROOT,
      appName: "myapp",
      metadata,
    });

    expect(plan.artifact).toEqual({ kind: "ref", ref: "registry.example.com/python:3.12-custom" });
    expect(plan.endpoints).toEqual([{ port: 9000, protocol: "http", name: "web" }]);
    expect(plan.healthcheck?.port).toBe(9000);
    expect(plan.extensions["lando-service-python"]).toMatchObject({ port: 9000 });
  });

  test("rejects unsupported framework values with remediation", () => {
    const service = decodeService({ type: "python:3.12", framework: "rails" });
    expect(() =>
      python312ServiceType.toServicePlan({
        name: "web",
        service,
        appRoot: APP_ROOT,
        appName: "myapp",
        metadata,
      }),
    ).toThrow(/Unsupported Python framework "rails"\./);

    expect(() =>
      python312ServiceType.toServicePlan({
        name: "web",
        service,
        appRoot: APP_ROOT,
        appName: "myapp",
        metadata,
      }),
    ).toThrow(/Set framework to one of: django, fastapi, flask, none/);
  });

  test("rejects unsupported Python versions with remediation", () => {
    const service = decodeService({ type: "python:3.11" });
    expect(() =>
      python312ServiceType.toServicePlan({
        name: "web",
        service,
        appRoot: APP_ROOT,
        appName: "myapp",
        metadata,
      }),
    ).toThrow(/Unsupported Python version "3.11"\./);

    expect(() =>
      python312ServiceType.toServicePlan({
        name: "web",
        service,
        appRoot: APP_ROOT,
        appName: "myapp",
        metadata,
      }),
    ).toThrow(/Set type to one of: python:3.12/);
  });

  test("rejects user environment that targets reserved LANDO_* keys (spec §6.9)", () => {
    const service = decodeService({
      type: "python:3.12",
      environment: { LANDO_PROJECT: "evil", FOO: "bar" },
    });
    expect(() =>
      python312ServiceType.toServicePlan({
        name: "web",
        service,
        appRoot: APP_ROOT,
        appName: "myapp",
        metadata,
      }),
    ).toThrow(/reserved LANDO_\* keys.*LANDO_PROJECT/);
  });
});
