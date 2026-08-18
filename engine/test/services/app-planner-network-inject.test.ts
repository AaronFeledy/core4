import { createHash as createNodeHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";

import { makeLandoPaths } from "@lando/paths";
import { LandofileValidationError } from "@lando/sdk/errors";
import { GlobalConfig, LandofileShape, ServiceName } from "@lando/sdk/schema";
import { AppPlanner, ConfigService, PathsService } from "@lando/sdk/services";

import { rememberLandofileAppRoot } from "@lando/landofile/app-root-provenance";
import { PluginRegistryLive } from "../../src/plugins/registry.ts";
import { FileSystemLive } from "../../src/services/file-system.ts";
import { AppPlannerLive } from "../../src/services/planner.ts";

import { TestRuntimeProvider } from "@lando/sdk/test";

const PEM = (name: string): string => `-----BEGIN CERTIFICATE-----\n${name}\n-----END CERTIFICATE-----\n`;

const digest = (pem: string): string => createNodeHash("sha256").update(pem, "utf-8").digest("hex");

const configLayer = (config: GlobalConfig) =>
  Layer.succeed(ConfigService, {
    load: Effect.succeed(config),
    get: <K extends keyof GlobalConfig>(key: K) => Effect.succeed(config[key]),
  });

const planEffect = (input: {
  readonly appRoot: string;
  readonly cacheRoot: string;
  readonly config: GlobalConfig;
  readonly landofile: LandofileShape;
}) => {
  const dependencies = Layer.mergeAll(
    PluginRegistryLive,
    FileSystemLive,
    configLayer(input.config),
    Layer.succeed(
      PathsService,
      makeLandoPaths({
        platform: "linux",
        home: input.appRoot,
        env: {},
        userCacheRoot: input.cacheRoot,
      }),
    ),
  );
  const planner = AppPlannerLive.pipe(Layer.provide(dependencies));
  return Effect.flatMap(AppPlanner, (service) =>
    service.plan(rememberLandofileAppRoot(input.landofile, input.appRoot), TestRuntimeProvider.capabilities),
  ).pipe(Effect.provide(planner));
};

const plan = (input: Parameters<typeof planEffect>[0]) => Effect.runPromise(planEffect(input));

const serviceFeatureBuildSteps = (extensions: Readonly<Record<string, unknown>>) => {
  const extension = extensions["@lando/core/service-features"];
  if (typeof extension !== "object" || extension === null || !("buildSteps" in extension)) return [];
  const buildSteps = extension.buildSteps;
  return Array.isArray(buildSteps) ? buildSteps : [];
};

const expectProjectCaRejection = async (input: {
  readonly appRoot: string;
  readonly cacheRoot: string;
  readonly authoredPath: string;
  readonly remediation: string;
}) => {
  const exit = await Effect.runPromiseExit(
    planEffect({
      appRoot: input.appRoot,
      cacheRoot: input.cacheRoot,
      config: Schema.decodeUnknownSync(GlobalConfig)({}),
      landofile: Schema.decodeUnknownSync(LandofileShape)({
        name: "trust-invalid",
        runtime: 4,
        services: { web: { type: "node:22", security: { ca: [input.authoredPath] } } },
      }),
    }),
  );

  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected planner failure");
  const failure = Option.getOrThrow(Cause.failureOption(exit.cause));
  expect(failure).toBeInstanceOf(LandofileValidationError);
  expect(String(failure)).toContain("security.ca");
  expect(String(failure)).toContain(input.remediation);
};

test("injects global, project, and inline CAs into lando-base services", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-planner-network-inject-"));
  const appRoot = join(root, "app");
  const cacheRoot = join(root, "cache");
  const globalPath = join(root, "global.pem");
  const projectPath = join(appRoot, "certs", "project.pem");
  const globalPem = PEM("global");
  const projectPem = PEM("project");
  const inlinePem = PEM("inline");

  try {
    await mkdir(join(appRoot, "certs"), { recursive: true });
    await writeFile(globalPath, globalPem, "utf-8");
    await writeFile(projectPath, projectPem, "utf-8");
    const config = Schema.decodeUnknownSync(GlobalConfig)({
      network: {
        ca: { certs: [globalPath], injectIntoServices: true },
        proxy: {
          https: "http://proxy.example.test:8443",
          noProxy: ["localhost"],
          injectIntoServices: true,
        },
      },
    });
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "trust-app",
      runtime: 4,
      services: {
        web: {
          type: "node:22",
          security: { ca: ["./certs/project.pem", inlinePem, globalPem] },
        },
        edge: {
          type: "compose",
          image: "nginx:alpine",
          security: { ca: ["../escape.pem", "definitely not a pem\n"] },
        },
      },
    });

    const result = await plan({ appRoot, cacheRoot, config, landofile });
    const web = result.services[ServiceName.make("web")];
    const edge = result.services[ServiceName.make("edge")];
    expect(web).toBeDefined();
    expect(edge).toBeDefined();
    if (web === undefined || edge === undefined) throw new Error("expected planned services");

    const caMounts = web.mounts.filter((mount) =>
      String(mount.target).startsWith("/usr/local/share/ca-certificates/lando-"),
    );
    expect(caMounts.map((mount) => mount.source)).toEqual([
      globalPath,
      projectPath,
      expect.stringContaining(cacheRoot),
    ]);
    expect(web.environment.HTTPS_PROXY).toBe("http://proxy.example.test:8443");
    expect(web.environment.NO_PROXY).toBe("localhost");
    expect(edge.environment.LANDO_CA_BUNDLE).toBeUndefined();
    expect(edge.environment.LANDO_CA_DIR).toBeUndefined();
    expect(edge.environment.LANDO_CA_CERT).toBeUndefined();
    expect(edge.mounts.some((mount) => String(mount.target).includes("lando-"))).toBe(false);
    expect(edge.mounts.some((mount) => String(mount.target) === "/etc/lando/certs/ca-bundle.pem")).toBe(
      false,
    );
    expect(
      serviceFeatureBuildSteps(edge.extensions).some((step) => step.id === "lando.security:trust-store"),
    ).toBe(false);

    const bundleMount = web.mounts.find((mount) => String(mount.target) === "/etc/lando/certs/ca-bundle.pem");
    expect(bundleMount?.source).toEqual(expect.stringContaining(cacheRoot));
    if (bundleMount?.source === undefined) throw new Error("expected CA bundle mount");
    expect(await readFile(bundleMount.source, "utf-8")).toBe(`${globalPem}${projectPem}${inlinePem}`);

    expect(serviceFeatureBuildSteps(web.extensions)).toContainEqual({
      id: "lando.security:trust-store",
      phase: "build",
      command:
        "set -e; mkdir -p /etc/lando/certs; if command -v update-ca-certificates >/dev/null 2>&1; then update-ca-certificates; elif command -v update-ca-trust >/dev/null 2>&1; then mkdir -p /etc/pki/ca-trust/source/anchors && cp /usr/local/share/ca-certificates/lando-*.crt /etc/pki/ca-trust/source/anchors/ && update-ca-trust extract; else echo 'No supported CA trust-store installer found.' >&2; exit 1; fi; cat /usr/local/share/ca-certificates/lando-*.crt > /etc/lando/certs/ca-bundle.pem",
      buildKeyInputs: { caDigests: [digest(globalPem), digest(projectPem), digest(inlinePem)].sort() },
      caFiles: expect.arrayContaining([
        expect.objectContaining({
          path: globalPath,
          digest: digest(globalPem),
          archiveName: `lando-${digest(globalPem)}.crt`,
        }),
        expect.objectContaining({
          path: projectPath,
          digest: digest(projectPem),
          archiveName: `lando-${digest(projectPem)}.crt`,
        }),
        expect.objectContaining({
          digest: digest(inlinePem),
          archiveName: `lando-${digest(inlinePem)}.crt`,
        }),
      ]),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps project CAs when global CA inheritance is disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-planner-network-opt-out-"));
  const appRoot = join(root, "app");
  const globalPath = join(root, "global.pem");
  const projectPath = join(appRoot, "project.pem");

  try {
    await mkdir(appRoot, { recursive: true });
    await writeFile(globalPath, PEM("global"), "utf-8");
    await writeFile(projectPath, PEM("project"), "utf-8");
    const result = await plan({
      appRoot,
      cacheRoot: join(root, "cache"),
      config: Schema.decodeUnknownSync(GlobalConfig)({
        network: { ca: { certs: [globalPath], injectIntoServices: true } },
      }),
      landofile: Schema.decodeUnknownSync(LandofileShape)({
        name: "trust-opt-out",
        runtime: 4,
        services: {
          web: {
            type: "node:22",
            security: { ca: ["./project.pem"], inheritNetworkCa: false },
          },
        },
      }),
    });

    const web = result.services[ServiceName.make("web")];
    expect(web?.mounts.some((mount) => mount.source === globalPath)).toBe(false);
    expect(web?.mounts.some((mount) => mount.source === projectPath)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails planning when a configured global CA is unreadable", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-planner-network-missing-global-"));
  const appRoot = join(root, "app");
  const missingPath = join(root, "missing.pem");

  try {
    await mkdir(appRoot, { recursive: true });
    const exit = await Effect.runPromiseExit(
      planEffect({
        appRoot,
        cacheRoot: join(root, "cache"),
        config: Schema.decodeUnknownSync(GlobalConfig)({
          network: { ca: { certs: [missingPath], injectIntoServices: true } },
        }),
        landofile: Schema.decodeUnknownSync(LandofileShape)({
          name: "trust-missing-global",
          runtime: 4,
          services: { web: { type: "node:22" } },
        }),
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("expected planner failure");
    const failure = Option.getOrThrow(Cause.failureOption(exit.cause));
    expect(failure).toBeInstanceOf(LandofileValidationError);
    expect(String(failure)).toContain(missingPath);
    expect(String(failure)).toContain("LANDO_NETWORK_CA_CERTS");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  ["outside app root", "../outside.pem", PEM("outside"), "stay inside the app root", false],
  ["invalid PEM", "./invalid.pem", "not a certificate\n", "valid PEM certificate", false],
  ["invalid inline PEM", "not a certificate\n", undefined, "valid PEM certificate", false],
  ["symlink escape", "./link.pem", PEM("outside"), "stay inside the app root", true],
])("rejects %s project CA input", async (_label, authoredPath, content, remediation, symlinkEscape) => {
  const root = await mkdtemp(join(tmpdir(), "lando-planner-network-invalid-"));
  const appRoot = join(root, "app");

  try {
    await mkdir(appRoot, { recursive: true });
    if (content !== undefined) {
      const source =
        authoredPath.startsWith("../") || symlinkEscape ? join(root, "outside.pem") : authoredPath;
      const absoluteSource = source.startsWith(root) ? source : join(appRoot, source);
      await writeFile(absoluteSource, content, "utf-8");
      if (symlinkEscape) await symlink(absoluteSource, join(appRoot, authoredPath));
    }
    await expectProjectCaRejection({
      appRoot,
      cacheRoot: join(root, "cache"),
      authoredPath,
      remediation,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
