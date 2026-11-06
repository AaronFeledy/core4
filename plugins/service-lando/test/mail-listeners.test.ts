import { expect, test } from "bun:test";
import { ServiceConfig } from "@lando/sdk/schema";
import { Effect, Result, Schema } from "effect";
import { mailhogServiceFeature, mailhogServiceType } from "../src/services/mailhog.ts";
import { mailpitServiceFeature, mailpitServiceType } from "../src/services/mailpit.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-08-19T00:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const validate = (type: "mailpit" | "mailhog", service: typeof ServiceConfig.Type) => {
  const feature = type === "mailpit" ? mailpitServiceFeature : mailhogServiceFeature;
  if (feature.validateEffective === undefined) throw new Error("Missing effective validation");
  return feature.validateEffective({
    serviceName: "mail",
    serviceType: type,
    appRoot: "/srv/apps/myapp",
    base: "lando",
    primary: true,
    normalizedConfig: service,
    config: {},
  });
};

for (const [type, serviceType, prefix] of [
  ["mailpit", mailpitServiceType, "MP"],
  ["mailhog", mailhogServiceType, "MH"],
] as const) {
  const service = (environment: Record<string, unknown>, port = 1025) =>
    Schema.decodeUnknownSync(ServiceConfig)({ type, port, environment });
  const resolve = (environment: Record<string, unknown>, port = 1025) =>
    Effect.runPromise(validate(type, service(environment, port)));

  test.each([":18025", "0.0.0.0:18025", "[::]:18025"])(
    `${type} advertises native HTTP bind %s`,
    async (bind) => {
      // Given
      const environment = {
        [`${prefix}_UI_BIND_ADDR`]: bind,
        ...(prefix === "MH" ? { MH_API_BIND_ADDR: bind } : {}),
      };
      // When
      const plan = await composeServicePlan({
        serviceType,
        service: service(environment, 8025),
        appRoot: "/srv/apps/myapp",
        serviceName: "mail",
        metadata,
      });
      // Then
      expect(plan.endpoints).toEqual([
        { _tag: "internal", port: 8025, protocol: "tcp", name: "smtp", primary: true },
        { _tag: "internal", port: 18025, protocol: "http", name: "ui", scan: { path: "/" } },
      ]);
      expect(plan.environment?.[`${prefix}_UI_BIND_ADDR`]).toBe(bind);
    },
  );

  test.each([
    "bad",
    "localhost:8025",
    "127.0.0.1:8025",
    "[::1]:8025",
    "192.0.2.1:8025",
    ":0",
    ":65536",
    ":1.5",
    "host:abc",
    "::1:8025",
    "host:8025/path",
    "[not-ipv6]:8025",
    "${PRIVATE_BIND}",
    { _tag: "SecretRef", reference: "PRIVATE_BIND" },
  ])(`${type} rejects invalid or nonliteral HTTP bind %j without leaking it`, async (bind) => {
    // Given / When / Then
    await expect(resolve({ [`${prefix}_UI_BIND_ADDR`]: bind })).rejects.toMatchObject({
      _tag: "ServiceFeatureError",
      issues: [expect.objectContaining({ path: ["environment", `${prefix}_UI_BIND_ADDR`] })],
    });
  });

  test.each([{}, { [`${prefix}_UI_BIND_ADDR`]: "0.0.0.0:8025" }])(
    `${type} rejects effective HTTP/SMTP collisions %j`,
    async (environment) => {
      // Given / When / Then
      await expect(resolve(environment, 8025)).rejects.toMatchObject({
        _tag: "ServiceFeatureError",
        issues: [expect.objectContaining({ path: ["port"] })],
      });
    },
  );

  test(`${type} preserves matching authored SMTP bind hosts`, async () => {
    // Given / When
    const plan = await composeServicePlan({
      serviceType,
      service: service({ [`${prefix}_SMTP_BIND_ADDR`]: "[::]:2525" }, 2525),
      appRoot: "/srv/apps/myapp",
      serviceName: "mail",
      metadata,
    });
    // Then
    expect(plan.environment?.[`${prefix}_SMTP_BIND_ADDR`]).toBe("[::]:2525");
  });

  test.each([":2525", "bad", { _tag: "SecretRef", reference: "SMTP_BIND" }])(
    `${type} rejects conflicting or invalid SMTP bind %j`,
    async (bind) => {
      // Given / When / Then
      await expect(resolve({ [`${prefix}_SMTP_BIND_ADDR`]: bind })).rejects.toMatchObject({
        _tag: "ServiceFeatureError",
        issues: [expect.objectContaining({ path: ["environment", `${prefix}_SMTP_BIND_ADDR`] })],
      });
    },
  );

  test.each([
    "private-value:not-a-port",
    { _tag: "SecretRef", reference: "private-value" },
    {
      _tag: "BoundText",
      parts: ["private-value:", { reference: "PRIVATE_BIND", encoding: "raw" }],
    },
  ])(`${type} omits native bind contents from typed failures: %j`, async (bind) => {
    // Given
    const serviceConfig = service({ [`${prefix}_UI_BIND_ADDR`]: bind });
    // When
    const result = await Effect.runPromise(Effect.result(validate(type, serviceConfig)));
    // Then
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(JSON.stringify(result.failure)).not.toContain("private-value");
      expect(result.failure.message).not.toContain("private-value");
    }
  });
}

test.each(["bad", ":0", ":65536", ":1.5", { _tag: "SecretRef", reference: "PRIVATE_API" }])(
  "MailHog validates API bind %j",
  async (bind) => {
    // Given
    const service = Schema.decodeUnknownSync(ServiceConfig)({
      type: "mailhog",
      environment: { MH_API_BIND_ADDR: bind },
    });
    // When / Then
    await expect(Effect.runPromise(validate("mailhog", service))).rejects.toMatchObject({
      _tag: "ServiceFeatureError",
      issues: [expect.objectContaining({ path: ["environment", "MH_API_BIND_ADDR"] })],
    });
  },
);

test("MailHog rejects SMTP colliding with a moved API listener", async () => {
  // Given
  const service = Schema.decodeUnknownSync(ServiceConfig)({
    type: "mailhog",
    port: 18026,
    environment: { MH_API_BIND_ADDR: ":18026" },
  });
  // When / Then
  await expect(Effect.runPromise(validate("mailhog", service))).rejects.toMatchObject({
    _tag: "ServiceFeatureError",
    issues: [expect.objectContaining({ path: ["port"] })],
  });
});

test("MailHog exposes distinct UI and API HTTP listeners", async () => {
  // Given
  const service = Schema.decodeUnknownSync(ServiceConfig)({
    type: "mailhog",
    environment: { MH_UI_BIND_ADDR: ":18025", MH_API_BIND_ADDR: ":18026" },
  });
  // When
  const plan = await composeServicePlan({
    serviceType: mailhogServiceType,
    service,
    appRoot: "/srv/apps/myapp",
    serviceName: "mail",
    metadata,
  });
  // Then
  expect(plan.endpoints.filter((endpoint) => endpoint.protocol === "http")).toEqual([
    { _tag: "internal", port: 18025, protocol: "http", name: "ui", scan: { path: "/" } },
    { _tag: "internal", port: 18026, protocol: "http", name: "api", scan: { path: "/api/v2/messages" } },
  ]);
});

test("MailHog rejects distinct bind strings sharing a numeric HTTP port", async () => {
  // Given
  const service = Schema.decodeUnknownSync(ServiceConfig)({
    type: "mailhog",
    environment: { MH_UI_BIND_ADDR: ":8025", MH_API_BIND_ADDR: "0.0.0.0:8025" },
  });
  // When / Then
  await expect(Effect.runPromise(validate("mailhog", service))).rejects.toMatchObject({
    _tag: "ServiceFeatureError",
    issues: [
      expect.objectContaining({ path: ["environment", "MH_API_BIND_ADDR"], suggestion: expect.any(String) }),
    ],
  });
});
