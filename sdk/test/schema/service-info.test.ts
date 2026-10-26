import { expect, test } from "bun:test";
import { ServiceInfo, ServiceState, StartedService } from "@lando/sdk/schema";
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
      source: "/host/app",
      target: "/app",
      readOnly: false,
      realization: "accelerated",
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
