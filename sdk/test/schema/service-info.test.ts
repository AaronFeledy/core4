import { expect, test } from "bun:test";
import { CertificatePlan, ServiceInfo, ServiceState, StartedService } from "@lando/sdk/schema";
import type { ServiceFeatureContext } from "@lando/sdk/services";
import { Schema } from "effect";

const service = {
  app: "demo",
  service: "db",
  api: 4,
  type: "postgres",
  provider: "test",
  primary: true,
  status: "running",
  connections: [
    {
      scope: "app",
      source: "listener",
      protocol: "tcp",
      host: "db",
      endpoint: { port: 15432, transport: "tcp", names: [], primary: true },
      binding: "assigned",
      port: 15432,
      url: "tcp://db:15432",
      alternateUrls: [],
      state: "active",
    },
  ],
} as const;

test.each([
  "unknown",
  "stopped",
  "starting",
  "running",
  "healthy",
  "unhealthy",
  "ready",
  "completed",
  "restarting",
  "paused",
  "error",
])("shares state %s between info and startup", (state) => {
  expect(Schema.is(ServiceState)(state)).toBe(true);
  expect(Schema.decodeUnknownSync(ServiceInfo)({ ...service, status: state }).status).toBe(state);
  expect(Schema.decodeUnknownSync(StartedService)({ name: "db", state, connections: [] }).state).toBe(state);
});

test("rejects unknown lifecycle strings instead of accepting arbitrary startup state", () => {
  expect(() =>
    Schema.decodeUnknownSync(StartedService)({ name: "db", state: "ready-ish", connections: [] }),
  ).toThrow();
});

test("preserves connection addresses when info crosses the SDK boundary", () => {
  // Given / When
  const decoded = Schema.decodeUnknownSync(ServiceInfo)(service);
  const encoded = Schema.encodeSync(ServiceInfo)(decoded);
  // Then
  expect(encoded).toEqual(service);
});

test("preserves the historical certificate struct and typed generated consumer", () => {
  expect(Object.keys(CertificatePlan.fields)).toEqual(["cn", "sans", "caId"]);
  const mapped = CertificatePlan.mapFields((fields) => ({ ...fields }));
  expect(Object.keys(mapped.fields)).toEqual(["cn", "sans", "caId"]);
  const certificate: Parameters<ServiceFeatureContext["setCerts"]>[0] = CertificatePlan.make({
    cn: "web.internal",
    sans: ["web.internal"],
    caId: "test",
  });
  expect(certificate.cn).toBe("web.internal");
  const input = { cn: "web.internal", sans: ["web.internal"], caId: "test" };
  const HistoricalCertificatePlan = Schema.Struct({
    cn: Schema.String,
    sans: Schema.Array(Schema.String),
    caId: Schema.String,
  });
  const historical = Schema.decodeUnknownSync(HistoricalCertificatePlan)(input, {
    onExcessProperty: "error",
  });
  expect(Schema.encodeSync(CertificatePlan)(historical)).toEqual(input);
  const decoded = Schema.decodeUnknownSync(CertificatePlan)(input, { onExcessProperty: "error" });
  const encoded = Schema.encodeSync(CertificatePlan)(decoded);
  expect(encoded).toEqual(input);
  expect(Schema.decodeUnknownSync(HistoricalCertificatePlan)(encoded, { onExcessProperty: "error" })).toEqual(
    input,
  );
});

test.each([
  { state: "none" },
  { state: "custom" },
  { state: "none", cn: "web" },
  { state: "custom", sans: ["web"] },
  { state: "generated", cn: "web", sans: [], caId: "test" },
])("rejects marker-only, mixed, or fabricated certificate-plan forms %j", (input) => {
  expect(() => Schema.decodeUnknownSync(CertificatePlan)(input, { onExcessProperty: "error" })).toThrow();
});

test("round trips safe service metadata and JSON provider details", () => {
  const input = {
    ...service,
    artifact: { kind: "ref", ref: "node:22-alpine", digest: "sha256:example" },
    user: "node",
    workingDirectory: "/app",
    hostnames: ["web", "web.demo.internal"],
    certs: { state: "custom" },
    health: {
      check: {
        kind: "tcp",
        intervalSeconds: 10,
        timeoutSeconds: 2,
        retries: 3,
        target: "service",
        userSource: "service",
        user: "node",
        commandConfigured: false,
        configPath: ["services", "web", "healthcheck"],
      },
      state: "unhealthy",
    },
    providerInfo: { observation: "limited", retries: 2, labels: ["safe"] },
  } as const;
  expect(Schema.encodeSync(ServiceInfo)(Schema.decodeUnknownSync(ServiceInfo)(input))).toEqual(input);
});

test("rejects non-JSON provider details", () => {
  expect(() =>
    Schema.decodeUnknownSync(ServiceInfo)({ ...service, providerInfo: { invalid: () => 1 } }),
  ).toThrow();
});

test("round trips storage lifetime and the full resolved application mount", () => {
  const input = {
    ...service,
    mounts: [
      {
        type: "volume",
        target: "/data",
        source: "database",
        readOnly: false,
        origin: "planned",
        observation: "present",
        lifetime: "retained",
      },
      { type: "unknown", target: "/unknown", origin: "runtime", observation: "present", lifetime: "unknown" },
    ],
    appMount: {
      type: "bind",
      source: "/host/app",
      target: "/app",
      readOnly: false,
      realization: "accelerated",
      role: "app",
      mountKey: "app-mount",
      includes: [".git"],
      excludes: ["node_modules"],
    },
  } as const;
  const result = Schema.encodeSync(ServiceInfo)(Schema.decodeUnknownSync(ServiceInfo)(input));
  expect(result).toEqual(input);
});

test("preserves display credentials alongside scoped connections", () => {
  // Given
  const input = {
    ...service,
    creds: { user: "app", database: "app", password: "[REDACTED]", rootPassword: "[REDACTED]" },
  };
  // When
  const encoded = Schema.encodeSync(ServiceInfo)(Schema.decodeUnknownSync(ServiceInfo)(input));
  // Then
  expect(encoded).toEqual(input);
});

test.each(["password", "rootPassword"])("rejects deferred %s in the info display boundary", (field) => {
  // Given
  const input = {
    ...service,
    creds: {
      user: "app",
      database: "app",
      password: "[REDACTED]",
      [field]: { _tag: "SecretRef", reference: "DATABASE_PASSWORD" },
    },
  };
  // When / Then
  expect(() => Schema.decodeUnknownSync(ServiceInfo)(input)).toThrow();
});

test("rejects legacy structured host endpoints when decoding service info", () => {
  // Given
  const { connections: _, ...metadata } = service;
  const legacy = {
    ...metadata,
    endpoints: [{ _tag: "internal", protocol: "tcp", port: 15432 }],
    internal: [],
  };
  // When / Then
  expect(() => Schema.decodeUnknownSync(ServiceInfo)(legacy)).toThrow();
});

test("rejects missing scoped connections when decoding service info", () => {
  // Given
  const { connections: _, ...incomplete } = service;
  // When / Then
  expect(() => Schema.decodeUnknownSync(ServiceInfo)(incomplete)).toThrow();
});

test.each([
  { name: "db", state: "running", endpoints: [] },
  { name: "db", state: "running", endpoints: [{ protocol: "tcp", port: 15432 }], internal: [] },
])("rejects invalid startup address contracts: %j", (input) => {
  // Given / When / Then
  expect(() => Schema.decodeUnknownSync(StartedService)(input)).toThrow();
});
