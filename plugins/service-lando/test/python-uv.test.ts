import { expect, test } from "bun:test";
import * as PluginRegistryLayer from "@lando/engine/plugins/registry";
import * as AppPlannerLayer from "@lando/engine/services/planner";
import { LandofileShape, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Schema } from "effect";

import { services } from "../src/index.ts";

const BuildSteps = Schema.Struct({
  buildSteps: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.optionalKey(Schema.String),
        phase: Schema.String,
        command: Schema.Unknown,
        user: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});

const buildStepsFor = (service: ServicePlan) =>
  Schema.decodeUnknownSync(BuildSteps)(service.extensions["@lando/core/service-features"]).buildSteps ?? [];

const planPython = async (overrides: Readonly<Record<string, unknown>> = {}) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "python-uv",
    services: { web: { type: "python:3.12", home: false, ...overrides } },
  });
  const plan = await Effect.runPromise(
    Effect.flatMap(AppPlanner, (planner) =>
      planner.plan(landofile, { ...TestRuntimeProvider.capabilities, artifactBuild: true }),
    ).pipe(
      Effect.provide(AppPlannerLayer.layer),
      Effect.provide(Layer.merge(services, PluginRegistryLayer.layer)),
    ),
  );
  const service = plan.services[ServiceName.make("web")];
  if (service === undefined) throw new Error("Python service missing");
  return service;
};

test.each(["django", "fastapi", "flask", "none"])(
  "plans uv in the stock image for framework=%s without changing startup",
  async (framework) => {
    // Given / When
    const service = await planPython({ framework });
    // Then
    expect(service.artifact).toEqual({ kind: "ref", ref: "python:3.12-slim" });
    const steps = buildStepsFor(service).filter((step) => step.id === "service-lando.python:uv");
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ phase: "build", user: "root" });
    expect(steps[0]?.command).toEqual(["python", "-m", "pip", "install", "--no-cache-dir", "uv==0.12.24"]);
    expect(service.command).toEqual(["sh", "-c", "tail -f /dev/null"]);
  },
);

test("keeps uv installation root-only while preserving authored process and build steps", async () => {
  // Given
  const command = ["python", "server.py"];
  const entrypoint = ["/usr/local/bin/python"];
  const authoredStep = "python -m pip install --user example-package";
  // When
  const service = await planPython({
    image: "python:3.12-slim",
    user: "1000:1000",
    command,
    entrypoint,
    build: { artifact: [authoredStep] },
  });
  // Then
  expect(service.user).toBe("1000:1000");
  expect(service.command).toEqual(command);
  expect(service.entrypoint).toEqual(entrypoint);
  const steps = buildStepsFor(service);
  expect(steps.find((step) => step.id === "service-lando.python:uv")?.user).toBe("root");
  expect(steps).toContainEqual(
    expect.objectContaining({ command: ["sh", "-lc", authoredStep], user: "1000:1000" }),
  );
});

test("leaves unrelated custom Python images free of stock uv installation", async () => {
  // Given
  const image = "registry.example.com/custom-runtime:latest";
  // When
  const service = await planPython({ image });
  // Then
  expect(service.artifact).toEqual({ kind: "ref", ref: image });
  expect(buildStepsFor(service).some((step) => step.id === "service-lando.python:uv")).toBe(false);
});

test("leaves an authored Dockerfile in charge of its Python toolchain", async () => {
  // Given
  const dockerfile = "FROM python:3.12-slim\nRUN python -m pip install uv==0.12.23\n";
  // When
  const service = await planPython({ build: { context: ".", dockerfileInline: dockerfile } });
  // Then
  expect(service.artifact).toMatchObject({ kind: "build", specInline: dockerfile });
  expect(buildStepsFor(service).some((step) => step.id === "service-lando.python:uv")).toBe(false);
});
