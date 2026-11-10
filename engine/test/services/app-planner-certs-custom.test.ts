import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { Cause, Effect, Exit, Option, Schema } from "effect";

import { LandofileValidationError } from "@lando/sdk/errors";
import { AppPlan, LandofileShape, ServiceName } from "@lando/sdk/schema";
import {
  certificateAuthorityGraph,
  makeUntouchableResolver,
  planAppPlannerCerts,
  planAppPlannerCertsEffect,
} from "./app-planner-certs-harness.ts";

const expectCertsRejection = async (input: {
  readonly appRoot: string;
  readonly cacheRoot: string;
  readonly certs: unknown;
  readonly message: string;
}) => {
  const exit = await Effect.runPromiseExit(
    planAppPlannerCertsEffect({
      appRoot: input.appRoot,
      cacheRoot: input.cacheRoot,
      landofile: Schema.decodeUnknownSync(LandofileShape)({
        name: "certs-invalid",
        runtime: 4,
        services: { web: { type: "node:22", certs: input.certs } },
      }),
    }),
  );

  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected planner failure");
  const failure = Option.getOrThrow(Cause.findErrorOption(exit.cause));
  expect(failure).toBeInstanceOf(LandofileValidationError);
  expect(String(failure)).toContain("services.web.certs");
  expect(String(failure)).toContain(input.message);
};

test("mounts validated custom certificate material without contacting the certificate authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-planner-certs-custom-"));
  const appRoot = join(root, "app");
  const cacheRoot = join(root, "cache");

  try {
    await mkdir(join(appRoot, "certs"), { recursive: true });
    await writeFile(join(appRoot, "certs", "custom.crt"), "cert\n", "utf-8");
    await writeFile(join(appRoot, "certs", "custom.key"), "key\n", "utf-8");
    const untouchable = makeUntouchableResolver();
    const appPlan = await planAppPlannerCerts({
      appRoot,
      cacheRoot,
      resolver: untouchable.resolver,
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

    expect(untouchable.calls()).toBe(0);
    const pair = appPlan.services[ServiceName.make("pair")];
    const single = appPlan.services[ServiceName.make("single")];
    const off = appPlan.services[ServiceName.make("off")];
    expect(pair?.environment.LANDO_SERVICE_CERT).toBe("/etc/lando/certs/leaf/pair.crt");
    expect(pair?.environment.LANDO_SERVICE_KEY).toBe("/etc/lando/certs/leaf/pair.key");
    expect(pair?.certs).toBeUndefined();
    expect(pair?.extensions["@lando/core/certs"]).toBe("custom");
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
    expect(single?.certs).toBeUndefined();
    expect(single?.extensions["@lando/core/certs"]).toBe("custom");

    expect(off?.environment.LANDO_SERVICE_CERT).toBeUndefined();
    expect(off?.certs).toBeUndefined();
    expect(off?.extensions["@lando/core/certs"]).toBe("none");
    const restored = Schema.decodeSync(AppPlan)(Schema.encodeSync(AppPlan)(appPlan));
    expect(restored.services[ServiceName.make("pair")]?.extensions["@lando/core/certs"]).toBe("custom");
    expect(restored.services[ServiceName.make("single")]?.extensions["@lando/core/certs"]).toBe("custom");
    expect(restored.services[ServiceName.make("off")]?.extensions["@lando/core/certs"]).toBe("none");
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
      message: "must stay inside the app root",
    });
    await expectCertsRejection({
      appRoot,
      cacheRoot,
      certs: "./certs/missing.crt",
      message: "could not be read",
    });
    await expectCertsRejection({
      appRoot,
      cacheRoot,
      certs: "./certs",
      message: "must be a regular file",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  { name: "no", candidates: [] },
  {
    name: "two undefaulted",
    candidates: [
      { id: "first", pluginName: "@acme/first", source: "user" },
      { id: "second", pluginName: "@acme/second", source: "user" },
    ],
  },
])("rejects certs: true when $name certificate authorities are selectable", async ({ candidates }) => {
  // Given: the contribution graph (not the bundled manifests) decides the candidates
  const root = await mkdtemp(join(tmpdir(), "lando-planner-certs-unavailable-"));
  const appRoot = join(root, "app");
  try {
    await mkdir(appRoot, { recursive: true });
    // When
    const exit = await Effect.runPromiseExit(
      planAppPlannerCertsEffect({
        appRoot,
        cacheRoot: join(root, "cache"),
        graph: certificateAuthorityGraph(candidates),
        landofile: Schema.decodeUnknownSync(LandofileShape)({
          name: "certs-no-ca",
          runtime: 4,
          services: { web: { type: "node:22", certs: true } },
        }),
      }),
    );

    // Then: the selection error's own message and remediation, each stated once
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("expected planner failure");
    const failure = Option.getOrThrow(Cause.findErrorOption(exit.cause));
    expect(failure).toBeInstanceOf(LandofileValidationError);
    if (!(failure instanceof LandofileValidationError)) throw new Error("expected a validation error");
    expect(failure.issues).toMatchObject([{ path: ["services", "web", "certs"] }]);
    const expected =
      candidates.length === 0
        ? {
            message: "services.web.certs No certificate authority is available.",
            remediation:
              "Enable or install a certificate authority plugin, or provide custom certificate paths.",
          }
        : {
            message:
              "services.web.certs Multiple certificate authorities are available and none is the platform default.",
            remediation:
              "Disable all but one certificate authority plugin or add one matching defaultFor declaration.",
          };
    expect({ message: failure.message, remediation: failure.remediation }).toEqual(expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
