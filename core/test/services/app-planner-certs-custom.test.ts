import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { Cause, Effect, Exit, Option, Schema } from "effect";

import { LandofileValidationError } from "@lando/sdk/errors";
import { LandofileShape, ServiceName } from "@lando/sdk/schema";
import { makeTestCertificateAuthority } from "@lando/sdk/test";

import { planAppPlannerCerts, planAppPlannerCertsEffect } from "./app-planner-certs-harness.ts";

const expectCertsRejection = async (input: {
  readonly appRoot: string;
  readonly cacheRoot: string;
  readonly certs: unknown;
  readonly remediation: string;
}) => {
  const exit = await Effect.runPromiseExit(
    planAppPlannerCertsEffect({
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

test("mounts validated custom certificate material without contacting the certificate authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-planner-certs-custom-"));
  const appRoot = join(root, "app");
  const cacheRoot = join(root, "cache");

  try {
    await mkdir(join(appRoot, "certs"), { recursive: true });
    await writeFile(join(appRoot, "certs", "custom.crt"), "cert\n", "utf-8");
    await writeFile(join(appRoot, "certs", "custom.key"), "key\n", "utf-8");
    const ca = makeTestCertificateAuthority();
    const appPlan = await planAppPlannerCerts({
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
      planAppPlannerCertsEffect({
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
