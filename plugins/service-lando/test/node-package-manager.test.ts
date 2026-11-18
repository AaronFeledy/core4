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
  COREPACK_PIN,
  COREPACK_PREFIX,
  NODE_PACKAGE_MANAGER_STEP_ID,
  NodePackageManagerConfig,
  type NodePackageManagerName,
  PACKAGE_MANAGER_LAUNCHER_REVISION,
} from "../src/services/node-package-manager.ts";
import { resolveNodePackageManager } from "../src/services/node-package-manager-declaration.ts";
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
        sourceField: "packageManager",
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
    expect(failure.projectFile).toBe("apps/web/package.json");
    expect(failure.message).not.toMatch(/apps\/web\/package\.json|packageManager/u);
    expect(failure.suggestion).toMatch(/exact "<name>@<version>" spec|integrity suffix|extra suffix/u);
    expect(failure.projectFileSourcePath).toEqual(["packageManager"]);
  });

  test("rejects a non-string value naming the declaring file", () => {
    const failure = packageManagerFailure([packageJson("package.json", { packageManager: 42 })]);
    expect(failure.projectFile).toBe("package.json");
    expect(failure.projectFileSourcePath).toEqual(["packageManager"]);
  });

  test("rejects a package manager Lando cannot provision", () => {
    const failure = packageManagerFailure([
      packageJson("apps/web/package.json", { packageManager: "deno@2.0.0" }),
    ]);
    expect(failure.message).toContain('names "deno"');
    expect(failure.suggestion).toMatch(/Use a supported manager/);
    expect(failure.suggestion).toContain("remove the declaration");
    expect(failure.suggestion).not.toContain("globals");
  });

  test("recognises bun as a no-op that stops the walk", () => {
    expect(
      resolvePackageManager([
        packageJson("apps/web/package.json", { packageManager: "bun@1.2.0" }),
        packageJson("package.json", { packageManager: "yarn@4.18.1" }),
      ]),
    ).toEqual({
      name: "bun",
      version: "1.2.0",
      sourcePath: "apps/web/package.json",
      sourceField: "packageManager",
    });
  });

  test("returns undefined when no package.json declares a manager", () => {
    expect(resolvePackageManager([absent("package.json")])).toBeUndefined();
    expect(resolvePackageManager([packageJson("package.json", { name: "app" })])).toBeUndefined();
  });
});

describe("devEngines.packageManager", () => {
  test("resolves an exact dev-only pin", () => {
    expect(
      resolvePackageManager([
        packageJson("package.json", {
          devEngines: { packageManager: { name: "pnpm", version: "9.15.0", onFail: "ignore" } },
        }),
      ]),
    ).toEqual({
      name: "pnpm",
      version: "9.15.0",
      sourcePath: "package.json",
      sourceField: "devEngines.packageManager",
    });
  });

  test("rejects a dev-only range because planning cannot resolve it offline", () => {
    const failure = packageManagerFailure([
      packageJson("package.json", { devEngines: { packageManager: { name: "pnpm", version: "^9" } } }),
    ]);
    expect(failure.projectFileSourcePath).toEqual(["devEngines", "packageManager", "version"]);
    expect(failure.suggestion).toContain('"9.15.0"');
    expect(failure.suggestion).not.toContain("<name>@");
  });

  test("rejects a dev-only declaration without a version", () => {
    const failure = packageManagerFailure([
      packageJson("package.json", { devEngines: { packageManager: { name: "pnpm" } } }),
    ]);
    expect(failure.projectFileSourcePath).toEqual(["devEngines", "packageManager", "version"]);
  });

  test.each(["npm", "bun"])("recognises a dev-only %s no-op without a version", (name) => {
    expect(
      resolvePackageManager([packageJson("package.json", { devEngines: { packageManager: { name } } })]),
    ).toMatchObject({ name, version: "*", sourceField: "devEngines.packageManager" });
  });

  test("rejects an unknown onFail value", () => {
    const failure = packageManagerFailure([
      packageJson("package.json", {
        devEngines: { packageManager: { name: "pnpm", version: "9.15.0", onFail: "loud" } },
      }),
    ]);
    expect(failure.projectFileSourcePath).toEqual(["devEngines", "packageManager", "onFail"]);
  });

  test("ignores a devEngines object that declares only other engines", () => {
    expect(
      resolvePackageManager([
        packageJson("package.json", { devEngines: { runtime: { name: "node", version: "22" } } }),
      ]),
    ).toBeUndefined();
  });
});

describe("both declarations in one manifest", () => {
  const both = (top: string, dev: Record<string, unknown>) =>
    packageJson("package.json", { packageManager: top, devEngines: { packageManager: dev } });

  test("keeps the top-level pin when the dev range admits it", () => {
    expect(resolvePackageManager([both("pnpm@9.15.0", { name: "pnpm", version: "^9" })])).toEqual({
      name: "pnpm",
      version: "9.15.0",
      sourcePath: "package.json",
      sourceField: "packageManager",
    });
  });

  test("fails on a name mismatch by default", () => {
    const failure = packageManagerFailure([both("pnpm@9.15.0", { name: "yarn", version: "4.18.1" })]);
    expect(failure.projectFileSourcePath).toEqual(["devEngines", "packageManager", "name"]);
  });

  test("honours onFail ignore for a name mismatch", () => {
    expect(
      resolvePackageManager([both("pnpm@9.15.0", { name: "yarn", version: "4.18.1", onFail: "ignore" })]),
    ).toMatchObject({ name: "pnpm", sourceField: "packageManager" });
  });

  test("fails when the dev range excludes the top-level version", () => {
    const failure = packageManagerFailure([both("pnpm@9.15.0", { name: "pnpm", version: "^10" })]);
    expect(failure.projectFileSourcePath).toEqual(["devEngines", "packageManager", "version"]);
  });

  test("honours onFail warn for an excluding range", () => {
    expect(
      resolvePackageManager([both("pnpm@9.15.0", { name: "pnpm", version: "^10", onFail: "warn" })]),
    ).toMatchObject({ version: "9.15.0" });
  });

  test("rejects a dev-only integrity hash while the top-level pin exists", () => {
    const failure = packageManagerFailure([
      both("pnpm@9.15.0", { name: "pnpm", version: `9.15.0+sha512.${SHA512}`, onFail: "ignore" }),
    ]);
    expect(failure.projectFileSourcePath).toEqual(["devEngines", "packageManager", "version"]);
  });

  test("rejects differing integrity hashes", () => {
    const failure = packageManagerFailure([
      packageJson("package.json", {
        packageManager: `pnpm@9.15.0+sha512.${SHA512}`,
        devEngines: {
          packageManager: { name: "pnpm", version: `9.15.0+sha512.${"b".repeat(128)}`, onFail: "ignore" },
        },
      }),
    ]);
    expect(failure.message).toMatch(/different integrity hashes/);
  });
});

describe("nearest-file precedence", () => {
  const nestedYarn = packageJson("apps/web/package.json", { packageManager: "yarn@4.18.1" });
  const rootPnpm = packageJson("package.json", { packageManager: "pnpm@9.15.0" });

  test("prefers the nested package root over the app root", () => {
    expect(resolvePackageManager([nestedYarn, rootPnpm])).toMatchObject({
      name: "yarn",
      sourcePath: "apps/web/package.json",
    });
  });

  test("prefers a nested dev-only declaration over the app-root packageManager", () => {
    expect(
      resolvePackageManager([
        packageJson("apps/web/package.json", {
          devEngines: { packageManager: { name: "pnpm", version: "10.0.0" } },
        }),
        rootPnpm,
      ]),
    ).toMatchObject({ name: "pnpm", version: "10.0.0", sourcePath: "apps/web/package.json" });
  });

  test("falls back to the monorepo root when the nested package omits the field", () => {
    expect(
      resolvePackageManager([packageJson("apps/web/package.json", { name: "web" }), rootPnpm]),
    ).toMatchObject({ name: "pnpm", sourcePath: "package.json" });
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
    expect(failure.projectFile).toBe("apps/web/package.json");
  });
});

describe("node project files", () => {
  test("bare node declares version inputs plus the package manifests", () => {
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

  test("explicit types declare only the manifests, never a version file", () => {
    expect(node22ServiceType.projectFiles?.({ type: "node:22" })).toEqual([
      { path: "package.json", maxBytes: 1_048_576 },
    ]);
    expect(node22ServiceType.projectFiles?.({ type: "node:22", packageRoot: "apps/web" })).toEqual([
      { path: "apps/web/package.json", maxBytes: 1_048_576 },
      { path: "package.json", maxBytes: 1_048_576 },
    ]);
  });
});

describe("node package manager provisioning", () => {
  test("installs Corepack privately, seeds a fresh cache, and publishes only the selected launchers", async () => {
    const projectFiles = [
      present("apps/web/.nvmrc", "26\n"),
      packageJson("apps/web/package.json", { name: "web" }),
      packageJson("package.json", { packageManager: "yarn@1.22.22" }),
    ];
    const plan = await composeNodePlan({ packageRoot: "apps/web" }, projectFiles);
    const step = packageManagerStep(plan);
    const command = String(step?.command);

    expect(step?.phase).toBe("build");
    expect(step?.user).toBe("root");
    expect(command).toContain(`npm pack corepack@${COREPACK_PIN.version}`);
    expect(command).toContain(
      `'${COREPACK_PIN.sha256}' 'corepack-${COREPACK_PIN.version}.tgz' | sha256sum -c -`,
    );
    expect(command.indexOf("sha256sum -c -")).toBeLessThan(
      command.indexOf(`npm install --prefix '${COREPACK_PREFIX}'`),
    );
    expect(command).not.toContain("npm install -g");
    expect(command).toContain("install -g 'yarn@1.22.22'");
    expect(command).toContain("rm -f '/usr/local/bin/yarn'");
    expect(command).toContain("rm -f '/usr/local/bin/yarnpkg'");
    expect(command).not.toContain("/usr/local/bin/pnpm");
    expect(command).toContain("YARN_IGNORE_PATH=1");
    expect(command).toContain("--version");
    expect(step?.buildKeyInputs).toEqual({
      packageManager: { name: "yarn", version: "1.22.22" },
      corepack: { version: COREPACK_PIN.version, sha256: COREPACK_PIN.sha256 },
      launcher: PACKAGE_MANAGER_LAUNCHER_REVISION,
    });
    expect(plan.environment).toMatchObject({ PORT: "3000" });
    expect(plan.environment.COREPACK_HOME).toBeUndefined();
    expect(plan.environment.COREPACK_ENABLE_DOWNLOAD_PROMPT).toBeUndefined();
  });

  test("publishes pnpm and pnpx launchers without touching the yarn family", async () => {
    const plan = await composeNodePlan({}, [
      present(".nvmrc", "26\n"),
      packageJson("package.json", { packageManager: `pnpm@9.15.0+sha512.${SHA512}` }),
    ]);
    const command = String(packageManagerStep(plan)?.command);

    expect(command).toContain(`install -g 'pnpm@9.15.0+sha512.${SHA512}'`);
    expect(command).toContain("rm -f '/usr/local/bin/pnpm'");
    expect(command).toContain("rm -f '/usr/local/bin/pnpx'");
    expect(command).toContain(`"pnpx@9.15.0+sha512.${SHA512}"`);
    expect(command).not.toContain("/usr/local/bin/yarn");
    expect(command).not.toContain("YARN_IGNORE_PATH");
    expect(packageManagerStep(plan)?.buildKeyInputs).toEqual({
      packageManager: { name: "pnpm", version: "9.15.0", integrity: `sha512.${SHA512}` },
      corepack: { version: COREPACK_PIN.version, sha256: COREPACK_PIN.sha256 },
      launcher: PACKAGE_MANAGER_LAUNCHER_REVISION,
    });
  });

  test("provisions an explicit node type from its manifest", async () => {
    const plan = await composeNodePlan(
      {},
      [present(".nvmrc", "18\n"), packageJson("package.json", { packageManager: "pnpm@9.15.0" })],
      node22ServiceType,
    );

    expect(plan.type).toBe("node:22");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "node:22" });
    expect(packageManagerStep(plan)?.id).toBe(NODE_PACKAGE_MANAGER_STEP_ID);
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

  test.each(["npm@10.9.2", "bun@1.2.0"])("records %s provenance without a build step", async (spec) => {
    const projectFiles = [present(".nvmrc", "26\n"), packageJson("package.json", { packageManager: spec })];
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
      node: { packageManager: { name: spec.slice(0, spec.indexOf("@")) } },
    });

    const plan = await composeNodePlan({}, projectFiles);
    expect(packageManagerStep(plan)).toBeUndefined();
    expect(plan.environment.COREPACK_HOME).toBeUndefined();
  });

  test("reports the provisioned manager, field, and declaring file as provenance", async () => {
    const projectFiles = [
      present("apps/web/.nvmrc", "26\n"),
      packageJson("apps/web/package.json", {
        devEngines: { packageManager: { name: "yarn", version: "4.18.1" } },
      }),
      absent("package.json"),
    ];
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
        packageManager: {
          name: "yarn",
          version: "4.18.1",
          sourcePath: "apps/web/package.json",
          sourceField: "devEngines.packageManager",
        },
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

  test("drops a globals entry that repeats the selected exact version", async () => {
    const plan = await composeNodePlan({ globals: { yarn: "1.22.22" } }, [
      present(".nvmrc", "26\n"),
      packageJson("package.json", { packageManager: "yarn@1.22.22" }),
    ]);
    expect(buildStepsFor(plan).some((step) => step.id === NODE_GLOBALS_STEP_ID)).toBe(false);
    expect(packageManagerStep(plan)?.id).toBe(NODE_PACKAGE_MANAGER_STEP_ID);
  });

  test("rejects a globals entry that pins a different version", async () => {
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
    expect(result.failure.message).toContain("globals installs yarn@1.22.4");
    expect(result.failure.message).toContain("pins yarn@1.22.22");
    expect(result.failure.remediation).toBe(
      "Remove globals.yarn; packageManager in package.json owns that version.",
    );
    expect(result.failure.issues?.[0]?.path).toEqual(["globals", "yarn"]);
    expect(result.failure.issues?.[0]?.source).toBeUndefined();
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
});

describe("node feature config schema", () => {
  test("accepts a packageManager field with Corepack and launcher identity", () => {
    expect(
      Schema.decodeUnknownSync(NodePackageManagerConfig)({
        name: "yarn",
        version: "1.22.22",
        sourcePath: "package.json",
        sourceField: "packageManager",
        corepack: COREPACK_PIN,
        launcher: PACKAGE_MANAGER_LAUNCHER_REVISION,
      }),
    ).toEqual({
      name: "yarn",
      version: "1.22.22",
      sourcePath: "package.json",
      sourceField: "packageManager",
      corepack: COREPACK_PIN,
      launcher: PACKAGE_MANAGER_LAUNCHER_REVISION,
    });
  });
});
