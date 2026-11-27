import { expect, test } from "bun:test";
import * as PluginRegistryLayer from "@lando/engine/plugins/registry";
import * as AppPlannerLayer from "@lando/engine/services/planner";
import { makeLandoPaths } from "@lando/paths";
import { LandofileShape, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import { AppPlanner, PathsService } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Schema } from "effect";
import { services } from "../src/index.ts";
import { python312ServiceType } from "../src/services/python.ts";
import { compileTestLandofile } from "./support/compiled-landofile.ts";

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

test.each([
  { name: "stock", config: {}, expected: [":python-local"] },
  {
    name: "catalog tag with additive build",
    config: { image: "python:3.12-slim", build: { artifact: ["true"] } },
    expected: [":python-local"],
  },
  { name: "custom image", config: { image: "python:3.12" }, expected: [] },
  {
    name: "replacement build carrying the catalog tag",
    config: {
      image: "python:3.12-slim",
      build: { context: ".", dockerfile_inline: "FROM python:3.12-slim" },
    },
    expected: [],
  },
])("declares the expected launchers for $name", async ({ config, expected }) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "python-uv",
    services: { web: { type: "python:3.12", ...config } },
  });
  const service = landofile.services?.[ServiceName.make("web")];
  if (service === undefined) throw new Error("Python service missing");
  const resolution = await Effect.runPromise(
    python312ServiceType.resolve({
      name: "web",
      service,
      appRoot: "/srv/apps/python-uv",
      metadata: { source: "/srv/apps/python-uv/.lando.yml", runtime: 4, resolvedAt: "2026-01-01T00:00:00Z" },
    }),
  );
  expect(Object.keys(resolution.launchers ?? {})).toEqual([...expected]);
});

const planPython = async (overrides: Readonly<Record<string, unknown>> = {}) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "python-uv",
    services: { web: { type: "python:3.12", home: false, ...overrides } },
  });
  const plan = await Effect.runPromise(
    Effect.flatMap(AppPlanner, (planner) =>
      planner.plan(compileTestLandofile(landofile), {
        ...TestRuntimeProvider.capabilities,
        artifactBuild: true,
        projectUserMapping: "userns-keep-id",
      }),
    ).pipe(
      Effect.provide(
        AppPlannerLayer.layer.pipe(Layer.provide(Layer.succeed(PathsService, makeLandoPaths()))),
      ),
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
    expect(steps[0]?.command).toEqual([
      "sh",
      "-c",
      expect.stringMatching(/uv==0\.13\.9(?: --hash=sha256:[a-f0-9]{64}){4}[\s\S]*--require-hashes/),
    ]);
    expect(service.command).toEqual(["tail", "-f", "/dev/null"]);
    const { VIRTUAL_ENV, PATH } = service.environment;
    expect(VIRTUAL_ENV).toBe("/app/.venv");
    expect(PATH).toStartWith("/app/.venv/bin:");
  },
);

test("keeps uv installation root-only while preserving authored process and build steps", async () => {
  // Given
  const command = ["python", "server.py"];
  const entrypoint = ["/usr/local/bin/python"];
  const authoredStep = "python -m pip install --user example-package";
  // When
  const service = await planPython({
    image: "docker.io/library/python:3.12-slim",
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
  expect(steps.filter((step) => step.id?.startsWith("service-lando.python:")).map((step) => step.id)).toEqual(
    ["service-lando.python:uv"],
  );
  expect(steps).toContainEqual(
    expect.objectContaining({ command: ["sh", "-c", authoredStep], user: "1000:1000" }),
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
  expect(service.environment).not.toHaveProperty("VIRTUAL_ENV");
});

test("leaves an authored Dockerfile in charge of its Python toolchain", async () => {
  // Given
  const dockerfile = "FROM python:3.12-slim\nRUN python -m pip install uv==0.12.23\n";
  // When
  const service = await planPython({ build: { context: ".", dockerfile_inline: dockerfile } });
  // Then
  expect(service.artifact).toMatchObject({ kind: "build", specInline: dockerfile });
  expect(buildStepsFor(service).some((step) => step.id === "service-lando.python:uv")).toBe(false);
  expect(service.environment).not.toHaveProperty("VIRTUAL_ENV");
});

test.each([
  false,
  { target: "/app", includes: [".venv"] },
  { target: "/app", includes: ["./.venv"] },
  { target: "/app", includes: [".venv/"] },
  { target: "/app", includes: ["./.venv/"] },
  { target: "/root:workspace" },
] as const)("keeps stock Python unactivated for appMount %j", async (appMount) => {
  const service = await planPython({ appMount });
  expect(
    buildStepsFor(service)
      .filter((step) => step.id?.startsWith("service-lando.python:"))
      .map((step) => step.id),
  ).toEqual(["service-lando.python:uv"]);
  expect(service.environment).not.toHaveProperty("VIRTUAL_ENV");
  expect(service.environment).not.toHaveProperty("PATH");
  if (appMount !== false && "includes" in appMount) {
    expect(service.mounts.some((mount) => mount.target === "/app/.venv")).toBe(false);
  }
});

test("mounts a different dependency store at a different normalized target", async () => {
  const defaultService = await planPython();
  const service = await planPython({ appMount: { target: "/workspace/" } });
  expect(service.environment).toMatchObject({ VIRTUAL_ENV: "/workspace/.venv" });
  const store = (planned: ServicePlan) =>
    planned.mounts.find(
      (mount) => mount.type === "volume" && mount.target === planned.environment.VIRTUAL_ENV,
    );
  expect(store(service)).toMatchObject({
    type: "volume",
    target: "/workspace/.venv",
    store: expect.stringMatching(/--env--python-[a-f0-9]{16}$/),
  });
  expect(store(defaultService)).not.toEqual(store(service));
});

test("authored environment takes precedence over venv defaults", async () => {
  const environment = { PATH: "/usr/bin:/bin", VIRTUAL_ENV: "/custom" };
  const service = await planPython({ environment });
  expect(service.environment).toMatchObject(environment);
});

test.each([[], ["python-env:/app/.venv"]])(
  "prepares the store as a writable project-user target (%j)",
  async (...mounts) => {
    const service = await planPython({ mounts, projectUser: "1000:1000" });
    const steps = buildStepsFor(service);
    const uv = steps.findIndex((step) => step.id === "service-lando.python:uv");
    const ownership = steps.findIndex((step) => step.id === "lando.storage:own-data-trees");
    expect(ownership).toBeGreaterThan(uv);
    expect(steps[ownership]?.command).toEqual(
      expect.arrayContaining([expect.stringContaining("chown -R '1000:1000' '/app/.venv'")]),
    );
  },
);

test.each([
  { mounts: ["./environment:/app/.venv/"] },
  { tmpfs: ["/app/.venv:size=8m"] },
  { volumes: ["./environment:/app/.venv"] },
  { mounts: ["python-env:/app/.venv"] },
])("does not build or activate a venv hidden by %j", async (overrides) => {
  const service = await planPython(overrides);
  expect(service.environment).not.toHaveProperty("VIRTUAL_ENV");
  expect(service.dependsOn).toEqual([]);
  expect(buildStepsFor(service).map((step) => step.id)).not.toContain("service-lando.python:venv");
});
