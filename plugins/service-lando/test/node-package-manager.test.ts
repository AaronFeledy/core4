import { describe, expect, test } from "bun:test";
import { sha256Hex } from "@lando/sdk/digest";
import { LandofileShape, type ServiceConfig, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import type { ServiceType, ServiceTypeProjectFileInput } from "@lando/sdk/services";
import { Effect, Schema } from "effect";

import {
  NODE_FEATURE_ID,
  NODE_GLOBALS_STEP_ID,
  node22ServiceType,
  nodeServiceFeature,
  nodeServiceType,
} from "../src/services/node.ts";
import { NodeInferenceError } from "../src/services/node-inference.ts";
import {
  COREPACK_HOME,
  COREPACK_PIN,
  NODE_PACKAGE_MANAGER_STEP_ID,
  NodePackageManagerConfig,
  type NodePackageManagerName,
  resolveNodePackageManager,
} from "../src/services/node-package-manager.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-09-13T00:00:00Z",
  source: "/srv/apps/node-pm/.lando.yml",
  runtime: 4 as const,
};

const BuildSteps = Schema.Struct({
  buildSteps: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.optionalKey(Schema.String),
        phase: Schema.optionalKey(Schema.String),
        command: Schema.Unknown,
        user: Schema.optionalKey(Schema.String),
        buildKeyInputs: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
      }),
    ),
  ),
});

const present = (path: string, text: string): ServiceTypeProjectFileInput => ({
  path,
  present: true,
  text,
  sha256: sha256Hex(text),
});

const absent = (path: string): ServiceTypeProjectFileInput => ({ path, present: false });

const packageJson = (path: string, value: Record<string, unknown>): ServiceTypeProjectFileInput =>
  present(path, JSON.stringify(value));

const projectFilesFor = (
  root: string,
  value: Record<string, unknown>,
  engines = "26",
): ReadonlyArray<ServiceTypeProjectFileInput> => {
  const prefix = root === "." ? "" : `${root}/`;
  return [
    present(`${prefix}.nvmrc`, `${engines}\n`),
    packageJson(`${prefix}package.json`, value),
    ...(root === "." ? [] : [absent("package.json")]),
  ];
};

const resolvePackageManager = (inputs: ReadonlyArray<ServiceTypeProjectFileInput>) =>
  resolveNodePackageManager(inputs);

const packageManagerFailure = (inputs: ReadonlyArray<ServiceTypeProjectFileInput>): NodeInferenceError => {
  try {
    resolvePackageManager(inputs);
  } catch (cause) {
    if (cause instanceof NodeInferenceError) return cause;
    throw cause;
  }
  throw new Error("Expected packageManager resolution to fail.");
};

const decodeService = (raw: unknown): ServiceConfig => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "node-pm",
    services: { web: raw },
  });
  const service = landofile.services?.[ServiceName.make("web")];
  if (service === undefined) throw new Error("web service missing");
  return service;
};

const composeNodePlan = (
  raw: Record<string, unknown>,
  projectFiles: ReadonlyArray<ServiceTypeProjectFileInput>,
  serviceType: ServiceType = nodeServiceType,
): Promise<ServicePlan> =>
  composeServicePlan({
    serviceType,
    service: decodeService({ type: serviceType.id, ...raw }),
    appRoot: "/srv/apps/node-pm",
    appName: "node-pm",
    serviceName: "web",
    metadata,
    featureOverrides: new Map([[NODE_FEATURE_ID, nodeServiceFeature]]),
    projectFiles,
    applyAuthoredWrappers: false,
  });

const buildStepsFor = (plan: ServicePlan) =>
  Schema.decodeUnknownSync(BuildSteps)(plan.extensions["@lando/core/service-features"]).buildSteps ?? [];

const packageManagerStep = (plan: ServicePlan) =>
  buildStepsFor(plan).find((step) => step.id === NODE_PACKAGE_MANAGER_STEP_ID);

const SHA224 = "953c8233f7a92884eee2de69a1b92d1f2ec1655e66d08071ba9a02fa";
const SHA512 = "a".repeat(128);

describe("packageManager parsing", () => {
  test.each([
    ["yarn@1.22.22", "yarn", "1.22.22", undefined],
    ["yarn@4.18.1", "yarn", "4.18.1", undefined],
    [`yarn@4.18.1+sha224.${SHA224}`, "yarn", "4.18.1", `sha224.${SHA224}`],
    [`pnpm@9.15.0+sha512.${SHA512}`, "pnpm", "9.15.0", `sha512.${SHA512}`],
    ["npm@10.9.2", "npm", "10.9.2", undefined],
    ["yarn@4.18.1-rc.1", "yarn", "4.18.1-rc.1", undefined],
  ] satisfies ReadonlyArray<readonly [string, NodePackageManagerName, string, string | undefined]>)(
    "accepts %s",
    (spec, name, version, integrity) => {
      const selection = resolvePackageManager([packageJson("package.json", { packageManager: spec })]);
      expect(selection).toEqual({
        name,
        version,
        ...(integrity === undefined ? {} : { integrity }),
        sourcePath: "package.json",
      });
    },
  );

  test.each([
    ["yarn"],
    ["yarn@"],
    ["yarn@^4.0.0"],
    ["yarn@latest"],
    ["@1.22.22"],
    ["Yarn@1.22.22"],
    [`pnpm@9.15.0+sha512.${"a".repeat(127)}`],
    [`pnpm@9.15.0+md5.${"a".repeat(32)}`],
    [`pnpm@9.15.0+sha512.${"A".repeat(128)}`],
    ["yarn@https://example.test/yarn.tgz"],
    ["yarn@1.22.22+build+extra"],
    ["yarn@v1.22.22"],
    ["yarn@ 1.22.22"],
  ])("rejects malformed spec %s", (spec) => {
    const failure = packageManagerFailure([packageJson("apps/web/package.json", { packageManager: spec })]);
    expect(failure.message).toContain("apps/web/package.json");
    expect(failure.message).toMatch(/not a valid package manager spec/);
    expect(failure.suggestion).toMatch(/exact "<name>@<version>" spec/);
  });

  test("rejects a non-string value naming the declaring file", () => {
    const failure = packageManagerFailure([packageJson("package.json", { packageManager: 42 })]);
    expect(failure.message).toBe("packageManager in package.json must be a string.");
  });

  test("rejects a package manager Lando cannot provision and points at globals", () => {
    const failure = packageManagerFailure([
      packageJson("apps/web/package.json", { packageManager: "bun@1.2.0" }),
    ]);
    expect(failure.message).toContain('names "bun"');
    expect(failure.message).toContain("apps/web/package.json");
    expect(failure.suggestion).toMatch(/through globals, or use an explicit node:<version> type/);
  });

  test("returns undefined when no package.json declares packageManager", () => {
    expect(resolvePackageManager([absent("package.json")])).toBeUndefined();
    expect(resolvePackageManager([packageJson("package.json", { name: "app" })])).toBeUndefined();
  });
});

describe("packageManager nearest-file precedence", () => {
  const nestedYarn = packageJson("apps/web/package.json", { packageManager: "yarn@4.18.1" });
  const rootPnpm = packageJson("package.json", { packageManager: "pnpm@9.15.0" });

  test("prefers the nested package root over the app root", () => {
    expect(resolvePackageManager([nestedYarn, rootPnpm])).toMatchObject({
      name: "yarn",
      version: "4.18.1",
      sourcePath: "apps/web/package.json",
    });
  });

  test("falls back to the monorepo root when the nested package omits the field", () => {
    expect(
      resolvePackageManager([packageJson("apps/web/package.json", { name: "web" }), rootPnpm]),
    ).toMatchObject({ name: "pnpm", version: "9.15.0", sourcePath: "package.json" });
  });

  test("falls back to the monorepo root when the nested package is absent", () => {
    expect(resolvePackageManager([absent("apps/web/package.json"), rootPnpm])).toMatchObject({
      name: "pnpm",
      sourcePath: "package.json",
    });
  });

  test("a malformed nested declaration never defers to the root", () => {
    const failure = packageManagerFailure([
      packageJson("apps/web/package.json", { packageManager: "yarn@latest" }),
      rootPnpm,
    ]);
    expect(failure.message).toContain("apps/web/package.json");
  });
});

describe("bare node project files", () => {
  test("declares the app-root package.json only when packageRoot is set", () => {
    expect(nodeServiceType.projectFiles?.({ type: "node" })).toEqual([
      { path: ".nvmrc", maxBytes: 1_048_576 },
      { path: "package.json", maxBytes: 1_048_576 },
    ]);
    expect(nodeServiceType.projectFiles?.({ type: "node", packageRoot: "apps/web" })).toEqual([
      { path: "apps/web/.nvmrc", maxBytes: 1_048_576 },
      { path: "apps/web/package.json", maxBytes: 1_048_576 },
      { path: "package.json", maxBytes: 1_048_576 },
    ]);
  });
});

describe("bare node packageManagers provisioning", () => {
  test("plans one verified Corepack build step and runtime env", async () => {
    // Given a workspace package that inherits yarn from the monorepo root,
    const projectFiles = [
      present("apps/web/.nvmrc", "26\n"),
      packageJson("apps/web/package.json", { name: "web" }),
      packageJson("package.json", { packageManager: "yarn@1.22.22" }),
    ];

    // When the plan is composed,
    const plan = await composeNodePlan({ packageRoot: "apps/web" }, projectFiles);
    const step = packageManagerStep(plan);

    // Then one artifact-phase step verifies the pinned Corepack tarball, installs
    // it, and caches the declared manager version for offline runtime use.
    expect(step?.phase).toBe("build");
    expect(step?.user).toBe("root");
    const command = String(step?.command);
    expect(command).toContain(`npm pack corepack@${COREPACK_PIN.version}`);
    expect(command).toContain(
      `'${COREPACK_PIN.sha256}' 'corepack-${COREPACK_PIN.version}.tgz' | sha256sum -c -`,
    );
    expect(command.indexOf("sha256sum -c -")).toBeLessThan(
      command.indexOf(`npm install -g --force --no-fund --no-audit './corepack-${COREPACK_PIN.version}.tgz'`),
    );
    expect(command).toContain("corepack enable --install-directory /usr/local/bin 'yarn'");
    expect(command).toContain("corepack install -g 'yarn@1.22.22'");
    expect(command).toContain(`chmod -R a+rX '${COREPACK_HOME}'`);
    expect(step?.buildKeyInputs).toEqual({
      packageManager: { name: "yarn", version: "1.22.22" },
      corepack: { version: COREPACK_PIN.version, sha256: COREPACK_PIN.sha256 },
    });
    expect(plan.environment).toMatchObject({
      COREPACK_HOME,
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      PORT: "3000",
    });
  });

  test("passes the authored integrity through to the Corepack install", async () => {
    const plan = await composeNodePlan({}, [
      present(".nvmrc", "26\n"),
      packageJson("package.json", { packageManager: `pnpm@9.15.0+sha512.${SHA512}` }),
    ]);
    const command = String(packageManagerStep(plan)?.command);
    expect(command).toContain(`corepack install -g 'pnpm@9.15.0+sha512.${SHA512}'`);
    expect(packageManagerStep(plan)?.buildKeyInputs).toEqual({
      packageManager: { name: "pnpm", version: "9.15.0", integrity: `sha512.${SHA512}` },
      corepack: { version: COREPACK_PIN.version, sha256: COREPACK_PIN.sha256 },
    });
  });

  test("runs the provisioning step after the globals step", async () => {
    const plan = await composeNodePlan({ globals: { cowsay: "1.6.0" } }, [
      present(".nvmrc", "26\n"),
      packageJson("package.json", { packageManager: "yarn@1.22.22" }),
    ]);
    const ids = buildStepsFor(plan)
      .map((step) => step.id)
      .filter((id) => id?.startsWith("service-lando.node:"));
    expect(ids).toEqual([NODE_GLOBALS_STEP_ID, NODE_PACKAGE_MANAGER_STEP_ID]);
  });

  test("records npm provenance without adding a build step", async () => {
    const projectFiles = [
      present(".nvmrc", "26\n"),
      packageJson("package.json", { packageManager: "npm@10.9.2" }),
    ];
    const resolution = await Effect.runPromise(
      nodeServiceType.resolve({
        name: "web",
        service: { type: "node" },
        appRoot: "/srv/apps/node-pm",
        metadata,
        projectFiles,
      }),
    );
    expect(resolution.metadata).toMatchObject({
      node: { packageManager: { name: "npm", version: "10.9.2", sourcePath: "package.json" } },
    });

    const plan = await composeNodePlan({}, projectFiles);
    expect(packageManagerStep(plan)).toBeUndefined();
    expect(plan.environment.COREPACK_HOME).toBeUndefined();
    expect(plan.environment.COREPACK_ENABLE_DOWNLOAD_PROMPT).toBeUndefined();
  });

  test("reports the provisioned manager and its declaring file as provenance", async () => {
    const projectFiles = projectFilesFor("apps/web", { packageManager: "yarn@4.18.1" });
    const resolution = await Effect.runPromise(
      nodeServiceType.resolve({
        name: "web",
        service: { type: "node", packageRoot: "apps/web" },
        appRoot: "/srv/apps/node-pm",
        metadata,
        projectFiles,
      }),
    );

    expect(resolution.metadata).toEqual({
      node: {
        sourcePath: "apps/web/.nvmrc",
        normalizedConstraint: "26",
        artifact: "node:26",
        files: projectFiles.map((file) => ({
          path: file.path,
          present: file.present,
          ...(file.present ? { sha256: file.sha256 } : {}),
        })),
        packageManager: { name: "yarn", version: "4.18.1", sourcePath: "apps/web/package.json" },
      },
    });
  });

  test("does not let the app-root manifest supply Node engines to a nested package", async () => {
    const result = await Effect.runPromise(
      Effect.result(
        nodeServiceType.resolve({
          name: "web",
          service: { type: "node", packageRoot: "apps/web" },
          appRoot: "/srv/apps/node-pm",
          metadata,
          projectFiles: [
            absent("apps/web/.nvmrc"),
            absent("apps/web/package.json"),
            packageJson("package.json", { engines: { node: "22" }, packageManager: "pnpm@9.15.0" }),
          ],
        }),
      ),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") return;
    expect(result.failure.message).toMatch(/found neither \.nvmrc nor package\.json/);
  });

  test("build-key inputs follow the declaration and ignore unrelated package.json fields", async () => {
    const base = (extra: Record<string, unknown>, packageManager: string) =>
      composeNodePlan({}, [
        present(".nvmrc", "26\n"),
        packageJson("package.json", { packageManager, ...extra }),
      ]).then((plan) => packageManagerStep(plan)?.buildKeyInputs);

    const first = await base({ name: "app", scripts: { test: "bun test" } }, "yarn@1.22.22");
    const samePackages = await base({ name: "renamed", private: true }, "yarn@1.22.22");
    const newVersion = await base({ name: "app" }, "yarn@1.22.23");

    expect(samePackages).toEqual(first);
    expect(newVersion).not.toEqual(first);
    expect(newVersion).toMatchObject({ packageManager: { version: "1.22.23" } });
  });

  test("rejects a globals entry for the manager package.json owns", async () => {
    const result = await Effect.runPromise(
      Effect.result(
        nodeServiceType.resolve({
          name: "web",
          service: { type: "node", globals: { yarn: "1.22.4" } },
          appRoot: "/srv/apps/node-pm",
          metadata,
          projectFiles: [
            present(".nvmrc", "26\n"),
            packageJson("package.json", { packageManager: "yarn@1.22.22" }),
          ],
        }),
      ),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") return;
    expect(result.failure.message).toContain("globals installs yarn");
    expect(result.failure.message).toContain("already provisions yarn@1.22.22");
    expect(result.failure.remediation).toBe(
      "Remove globals.yarn; the packageManager field in package.json owns that version.",
    );
    expect(result.failure.issues?.[0]?.path).toEqual(["globals", "yarn"]);
  });

  test("leaves a globals entry for a different package alone", async () => {
    const plan = await composeNodePlan({ globals: { yarn: "1.22.4" } }, [
      present(".nvmrc", "26\n"),
      packageJson("package.json", { packageManager: "pnpm@9.15.0" }),
    ]);
    expect(
      buildStepsFor(plan)
        .map((step) => step.id)
        .filter((id) => id?.startsWith("service-lando.node:")),
    ).toEqual([NODE_GLOBALS_STEP_ID, NODE_PACKAGE_MANAGER_STEP_ID]);
  });

  test("does not read project files for an explicit node version", async () => {
    const plan = await composeNodePlan(
      {},
      [present(".nvmrc", "26\n"), packageJson("package.json", { packageManager: "yarn@1.22.22" })],
      node22ServiceType,
    );
    expect(buildStepsFor(plan).some((step) => step.id === NODE_PACKAGE_MANAGER_STEP_ID)).toBe(false);
    expect(plan.type).toBe("node:22");
    expect(plan.environment.COREPACK_HOME).toBeUndefined();
  });
});

describe("node feature config schema", () => {
  test("accepts a packageManager widened field", () => {
    expect(
      Schema.decodeUnknownSync(NodePackageManagerConfig)({
        name: "yarn",
        version: "1.22.22",
        sourcePath: "package.json",
      }),
    ).toEqual({ name: "yarn", version: "1.22.22", sourcePath: "package.json" });
  });
});
