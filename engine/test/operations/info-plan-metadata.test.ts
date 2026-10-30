import { expect, test } from "bun:test";
import { AbsolutePath, PortablePath, ServiceInfo, landoNetworkingPlan } from "@lando/sdk/schema";
import { Schema } from "effect";
import { AppInfoResultSchema } from "../../src/operations/info.ts";
import { plan, runInfo, service } from "./info-storage-fixture.ts";

test("projects selected artifact identity, user, and working directory without extra provider calls", async () => {
  const { row, calls } = await runInfo({
    ...service,
    artifact: { kind: "ref", ref: "node:22-alpine", digest: "sha256:example" },
    user: "node",
    workingDirectory: PortablePath.make("/app"),
  });
  if (row === undefined) throw new Error("Expected a service info row");

  expect(row).toMatchObject({ artifact: { ref: "node:22-alpine" }, user: "node", workingDirectory: "/app" });
  const wire = Schema.encodeSync(ServiceInfo)(row);
  expect(wire).toMatchObject({
    artifact: { kind: "ref", ref: "node:22-alpine", digest: "sha256:example" },
    user: "node",
    workingDirectory: "/app",
  });
  expect(calls).toEqual(["select", "inspect:web"]);
});

test("reports only safe build identity and omits absent plan metadata", async () => {
  const { row } = await runInfo({
    ...service,
    artifact: {
      kind: "build",
      context: AbsolutePath.make("/host/private/build"),
      args: { TOKEN: "never-print-build-arg" },
      specInline: "FROM private.example/secret-image",
      contentHash: "safe-content-hash",
    },
  });
  if (row === undefined) throw new Error("Expected a service info row");

  const rawJson = JSON.stringify(row);
  expect(rawJson).not.toContain("never-print-build-arg");
  expect(rawJson).not.toContain("private.example/secret-image");
  expect(rawJson).not.toContain("/host/private/build");
  const wire = Schema.encodeSync(ServiceInfo)(row);
  expect(wire).toMatchObject({ artifact: { kind: "build", contentHash: "safe-content-hash" } });
  expect(wire).not.toHaveProperty("user");
  expect(wire).not.toHaveProperty("workingDirectory");
  const json = JSON.stringify(wire);
  expect(json).not.toContain("never-print-build-arg");
  expect(json).not.toContain("private.example/secret-image");
  expect(json).not.toContain("/host/private/build");
  const commandJson = JSON.stringify(
    Schema.encodeSync(AppInfoResultSchema)({ app: "storage-info", services: [row] }),
  );
  expect(commandJson).not.toContain("never-print-build-arg");
  expect(commandJson).not.toContain("private.example/secret-image");
  expect(commandJson).not.toContain("/host/private/build");
});

test("deduplicates canonical network aliases without including certificate or host-alias names", async () => {
  const networked = {
    ...plan,
    networking: landoNetworkingPlan({
      slug: plan.slug,
      serviceNames: ["web"],
      sharedCrossAppNetwork: true,
      bridgeAliases: { web: ["bridge-alias", "overlap"] },
      serviceHostnames: { web: ["overlap", "shared-alias"] },
      authoredNetworks: [
        { key: "private", external: false, members: { web: ["overlap", "authored-alias"] } },
      ],
    }),
  };
  const { row, calls } = await runInfo(
    {
      ...service,
      certs: { cn: "route-canary.test", sans: ["san-canary.test"], caId: "ca" },
      hostAliases: [{ hostname: "host-alias-canary.test", ip: "127.0.0.2" }],
    },
    undefined,
    undefined,
    undefined,
    networked,
  );
  expect(row?.hostnames).toEqual([
    "web",
    "bridge-alias",
    "overlap",
    "web.storage-info.internal",
    "shared-alias",
    "authored-alias",
  ]);
  const rawJson = JSON.stringify(row);
  expect(rawJson).not.toContain("san-canary.test");
  expect(rawJson).not.toContain("host-alias-canary.test");
  expect(calls).toEqual(["select", "inspect:web"]);
});

test("reports no hostnames when networking disables all service attachments", async () => {
  const { row } = await runInfo(service, undefined, undefined, undefined, {
    ...plan,
    networking: { perAppBridge: null },
  });
  expect(row?.hostnames).toEqual([]);
});

test("reports planned health settings and observed health independently of lifecycle", async () => {
  const { row, calls } = await runInfo(
    {
      ...service,
      healthcheck: {
        kind: "command",
        command: "echo secret-health-command",
        url: "https://secret-health-url.test/",
        intervalSeconds: 10,
        timeoutSeconds: 3,
        retries: 2,
        startPeriodSeconds: 4,
      },
    },
    undefined,
    undefined,
    "unhealthy",
  );
  if (row === undefined) throw new Error("Expected a service info row");
  expect(row?.status).toBe("running");
  expect(row?.health).toEqual({
    check: {
      kind: "command",
      intervalSeconds: 10,
      timeoutSeconds: 3,
      retries: 2,
      startPeriodSeconds: 4,
      target: "service",
      userSource: "image",
      commandConfigured: true,
      configPath: ["services", "web", "healthcheck"],
    },
    state: "unhealthy",
  });
  const rawJson = JSON.stringify(row);
  expect(rawJson).not.toContain("secret-health-command");
  expect(rawJson).not.toContain("secret-health-url.test");
  const commandJson = JSON.stringify(
    Schema.encodeSync(AppInfoResultSchema)({ app: "storage-info", services: [row] }),
  );
  expect(commandJson).not.toContain("secret-health-command");
  expect(commandJson).not.toContain("secret-health-url.test");
  expect(calls).toEqual(["select", "inspect:web"]);
});

test("distinguishes an explicit none healthcheck, a readiness-only probe, and absent health", async () => {
  const check = { kind: "none" as const, intervalSeconds: 1, timeoutSeconds: 1, retries: 1 };
  const explicit = await runInfo({ ...service, healthcheck: check });
  const readinessOnly = await runInfo({ ...service, readiness: check });
  const absent = await runInfo(service);
  expect(explicit.row?.health).toMatchObject({ check, state: "not-monitored" });
  expect(readinessOnly.row?.health).toEqual({ state: "unknown" });
  expect(readinessOnly.row?.readiness).toMatchObject({ state: "disabled", source: "unknown" });
  expect(absent.row?.health).toEqual({ state: "unknown" });
  expect(absent.row?.readiness).toEqual({ state: "not-configured", source: "none" });
});

test.each(["none", "custom"] as const)("projects private certificate provenance %s", async (state) => {
  const { row, calls } = await runInfo({
    ...service,
    extensions: { "@lando/core/certs": state },
  });
  if (row === undefined) throw new Error("Expected a service info row");
  expect(row.certs).toEqual({ state });
  expect(Schema.encodeSync(ServiceInfo)(row).certs).toEqual({ state });
  expect(calls).toEqual(["select", "inspect:web"]);
});

test.each([undefined, "none", "custom", { state: "custom", token: "extension-secret" }] as const)(
  "generated certificate plan takes precedence over private marker %j",
  async (marker) => {
    const { row, calls } = await runInfo({
      ...service,
      certs: { cn: "web", sans: ["web"], caId: "test" },
      extensions: marker === undefined ? {} : { "@lando/core/certs": marker },
    });
    if (row === undefined) throw new Error("Expected a service info row");
    expect(row.certs).toEqual({ state: "generated" });
    expect(Schema.encodeSync(ServiceInfo)(row).certs).toEqual({ state: "generated" });
    expect(JSON.stringify(row)).not.toContain("extension-secret");
    expect(calls).toEqual(["select", "inspect:web"]);
  },
);

test.each([
  ["generated", "forbidden-generated"],
  ["unknown", "unknown-string"],
  [null, "null"],
  [42, "number"],
  [true, "boolean"],
  [["custom"], "array"],
  [new String("custom"), "boxed-string"],
  [
    {
      state: "custom",
      secret: "extension-secret",
      certPath: "/host/private/leaf.pem",
      cert: "CERT-PEM-CANARY",
      key: "KEY-PEM-CANARY",
    },
    "object",
  ],
] as const)("omits malformed certificate provenance %s (%s)", async (marker) => {
  const { row, calls } = await runInfo({
    ...service,
    extensions: {
      "@lando/core/certs": marker,
      "unrelated.secret": { token: "unrelated-extension-secret" },
    },
  });
  if (row === undefined) throw new Error("Expected a service info row");
  expect(row).not.toHaveProperty("certs");
  const rawJson = JSON.stringify(row);
  const encodedJson = JSON.stringify(Schema.encodeSync(ServiceInfo)(row));
  for (const json of [rawJson, encodedJson]) {
    expect(json).not.toContain("extension-secret");
    expect(json).not.toContain("unrelated-extension-secret");
    expect(json).not.toContain("/host/private/leaf.pem");
    expect(json).not.toContain("CERT-PEM-CANARY");
    expect(json).not.toContain("KEY-PEM-CANARY");
  }
  expect(calls).toEqual(["select", "inspect:web"]);
});

test("omits artifact identity when an older plan has no artifact", async () => {
  const { row } = await runInfo(service);
  if (row === undefined) throw new Error("Expected a service info row");
  const wire = Schema.encodeSync(ServiceInfo)(row);
  expect(wire).not.toHaveProperty("artifact");
  expect(wire).not.toHaveProperty("user");
  expect(wire).not.toHaveProperty("workingDirectory");
  expect(row).not.toHaveProperty("certs");
});
