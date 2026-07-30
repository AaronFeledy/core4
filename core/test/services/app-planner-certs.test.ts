import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";

import { makeLandoPaths } from "@lando/paths";
import { LandofileValidationError } from "@lando/sdk/errors";
import { LandofileShape, ServiceName } from "@lando/sdk/schema";
import { AppPlanner, CertificateAuthority, PathsService } from "@lando/sdk/services";

import { rememberLandofileAppRoot } from "../../src/landofile/app-root-provenance.ts";
import { PluginRegistryLive } from "../../src/plugins/registry.ts";
import { FileSystemLive } from "../../src/services/file-system.ts";
import { AppPlannerLive } from "../../src/services/planner.ts";

import { TestRuntimeProvider, makeTestCertificateAuthority } from "@lando/sdk/test";

type TestCa = ReturnType<typeof makeTestCertificateAuthority>;

const planEffect = (input: {
  readonly appRoot: string;
  readonly cacheRoot: string;
  readonly landofile: LandofileShape;
  readonly ca?: TestCa | undefined;
}) => {
  const dependencies = Layer.mergeAll(
    PluginRegistryLive,
    FileSystemLive,
    Layer.succeed(
      PathsService,
      makeLandoPaths({
        platform: "linux",
        home: input.appRoot,
        env: {},
        userCacheRoot: input.cacheRoot,
      }),
    ),
    ...(input.ca === undefined ? [] : [Layer.succeed(CertificateAuthority, input.ca)]),
  );
  const planner = AppPlannerLive.pipe(Layer.provide(dependencies));
  return Effect.flatMap(AppPlanner, (service) =>
    service.plan(rememberLandofileAppRoot(input.landofile, input.appRoot), TestRuntimeProvider.capabilities),
  ).pipe(Effect.provide(planner));
};

const plan = (input: Parameters<typeof planEffect>[0]) => Effect.runPromise(planEffect(input));

const expectCertsRejection = async (input: {
  readonly appRoot: string;
  readonly cacheRoot: string;
  readonly certs: unknown;
  readonly remediation: string;
}) => {
  const exit = await Effect.runPromiseExit(
    planEffect({
      appRoot: input.appRoot,
      cacheRoot: input.cacheRoot,
      ca: makeTestCertificateAuthority(),
      landofile: Schema.decodeUnknownSync(LandofileShape)({
        name: "certs-invalid",
        runtime: 4,
        services: { web: { type: "node:22", certs: input.certs } },
      }),
    }),
  );

  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected planner failure");
  const failure = Option.getOrThrow(Cause.failureOption(exit.cause));
  expect(failure).toBeInstanceOf(LandofileValidationError);
  expect(String(failure)).toContain("services.web.certs");
  expect(String(failure)).toContain(input.remediation);
};

test("issues a leaf certificate with the documented SAN coverage for certs: true", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-planner-certs-"));
  const appRoot = join(root, "app");
  const cacheRoot = join(root, "cache");

  try {
    await mkdir(appRoot, { recursive: true });
    const ca = makeTestCertificateAuthority();
    const appPlan = await plan({
      appRoot,
      cacheRoot,
      ca,
      landofile: Schema.decodeUnknownSync(LandofileShape)({
        name: "certs-app",
        runtime: 4,
        services: {
          web: {
            type: "node:22",
            certs: true,
            hostnames: ["web.internal.test"],
            routes: [{ hostname: "certs-app.lndo.site" }],
          },
          edge: { type: "compose", image: "nginx:alpine", certs: true },
        },
        proxy: { web: [{ hostname: "alias.lndo.site" }] },
      }),
    });

    const issued = ca.calls.filter((call) => call.op === "issueCert");
    expect(issued).toHaveLength(1);
    expect(issued[0]?.op === "issueCert" ? issued[0].spec.cn : undefined).toBe("web.certs-app.internal");
    expect(issued[0]?.op === "issueCert" ? issued[0].spec.sans : undefined).toEqual([
      "web",
      "web.certs-app.internal",
      "web.internal.test",
      "certs-app.lndo.site",
      "alias.lndo.site",
      "localhost",
      "127.0.0.1",
    ]);

    const web = appPlan.services[ServiceName.make("web")];
    expect(web?.certs).toEqual({
      cn: "web.certs-app.internal",
      sans: [
        "web",
        "web.certs-app.internal",
        "web.internal.test",
        "certs-app.lndo.site",
        "alias.lndo.site",
        "localhost",
        "127.0.0.1",
      ],
      caId: "test",
    });
    expect(web?.environment.LANDO_SERVICE_CERT).toBe("/etc/lando/certs/leaf/web.crt");
    expect(web?.environment.LANDO_SERVICE_KEY).toBe("/etc/lando/certs/leaf/web.key");
    expect(web?.mounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "/tmp/test-certs/web.certs-app.internal.crt",
          target: "/etc/lando/certs/leaf/web.crt",
          readOnly: true,
        }),
        expect.objectContaining({
          source: "/tmp/test-certs/web.certs-app.internal.key",
          target: "/etc/lando/certs/leaf/web.key",
          readOnly: true,
        }),
      ]),
    );

    // l337-base services never compose lando.certs, so `certs: true` there issues nothing.
    const edge = appPlan.services[ServiceName.make("edge")];
    expect(edge?.certs).toBeUndefined();
    expect(edge?.environment.LANDO_SERVICE_CERT).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mounts validated custom certificate material without contacting the certificate authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-planner-certs-custom-"));
  const appRoot = join(root, "app");
  const cacheRoot = join(root, "cache");

  try {
    await mkdir(join(appRoot, "certs"), { recursive: true });
    await writeFile(join(appRoot, "certs", "custom.crt"), "cert\n", "utf-8");
    await writeFile(join(appRoot, "certs", "custom.key"), "key\n", "utf-8");
    const ca = makeTestCertificateAuthority();
    const appPlan = await plan({
      appRoot,
      cacheRoot,
      ca,
      landofile: Schema.decodeUnknownSync(LandofileShape)({
        name: "certs-custom",
        runtime: 4,
        services: {
          pair: {
            type: "node:22",
            certs: { cert: "./certs/custom.crt", key: "./certs/custom.key" },
          },
          single: { type: "node:22", certs: "./certs/custom.crt" },
          off: { type: "node:22", certs: false },
        },
      }),
    });

    expect(ca.calls).toEqual([]);
    const pair = appPlan.services[ServiceName.make("pair")];
    const single = appPlan.services[ServiceName.make("single")];
    const off = appPlan.services[ServiceName.make("off")];
    expect(pair?.environment.LANDO_SERVICE_CERT).toBe("/etc/lando/certs/leaf/pair.crt");
    expect(pair?.environment.LANDO_SERVICE_KEY).toBe("/etc/lando/certs/leaf/pair.key");
    expect(pair?.certs).toBeUndefined();
    expect(pair?.mounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: join(appRoot, "certs", "custom.crt"),
          target: "/etc/lando/certs/leaf/pair.crt",
          readOnly: true,
        }),
      ]),
    );

    expect(single?.environment.LANDO_SERVICE_CERT).toBe("/etc/lando/certs/leaf/single.crt");
    expect(single?.environment.LANDO_SERVICE_KEY).toBeUndefined();

    expect(off?.environment.LANDO_SERVICE_CERT).toBeUndefined();
    expect(off?.certs).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects custom certificate paths that escape the app root or do not exist", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-planner-certs-invalid-"));
  const appRoot = join(root, "app");
  const cacheRoot = join(root, "cache");

  try {
    await mkdir(appRoot, { recursive: true });
    await writeFile(join(root, "outside.crt"), "cert\n", "utf-8");
    await mkdir(join(appRoot, "certs"), { recursive: true });
    await expectCertsRejection({
      appRoot,
      cacheRoot,
      certs: "../outside.crt",
      remediation: "must stay inside the app root",
    });
    await expectCertsRejection({
      appRoot,
      cacheRoot,
      certs: "./certs/missing.crt",
      remediation: "could not be read",
    });
    await expectCertsRejection({
      appRoot,
      cacheRoot,
      certs: "./certs",
      remediation: "must be a regular file",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports remediation when certs: true has no certificate authority available", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-planner-certs-unavailable-"));
  const appRoot = join(root, "app");
  const cacheRoot = join(root, "cache");

  try {
    await mkdir(appRoot, { recursive: true });
    const exit = await Effect.runPromiseExit(
      planEffect({
        appRoot,
        cacheRoot,
        landofile: Schema.decodeUnknownSync(LandofileShape)({
          name: "certs-no-ca",
          runtime: 4,
          services: { web: { type: "node:22", certs: true } },
        }),
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("expected planner failure");
    const failure = Option.getOrThrow(Cause.failureOption(exit.cause));
    expect(failure).toBeInstanceOf(LandofileValidationError);
    expect(String(failure)).toContain("services.web.certs");
    expect(String(failure)).toContain("lando setup");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
