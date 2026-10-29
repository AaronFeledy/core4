import { expect, test } from "bun:test";
import { ContainerUser, ServiceConfig, ServiceName, effectiveReadiness } from "@lando/sdk/schema";
import { Effect, Result, Schema } from "effect";
import { applyAuthoredHealthcheck } from "../../src/planner/authored.ts";
import { validateServiceProbes } from "../../src/planner/service-probes.ts";
import { planWith } from "../services/build-app-runner-test-support.ts";

const native = {
  kind: "command",
  command: ["cheap"],
  intervalSeconds: 10,
  timeoutSeconds: 5,
  retries: 5,
} as const;
const strong = { ...native, command: ["strong"] };
const plan = planWith({ web: [] }, { web: { healthcheck: native, readiness: strong } });
const web = plan.services[ServiceName.make("web")];
if (web === undefined) throw new TypeError("Missing fixture service");

test.each([false, ["custom"]])("native override preserves contributed readiness: %j", (healthcheck) => {
  // Given
  const config = Schema.decodeUnknownSync(ServiceConfig)({ healthcheck });
  // When
  const result = applyAuthoredHealthcheck(web, config);
  // Then
  expect(effectiveReadiness(result)).toEqual(strong);
});

test("explicit false readiness blocks native fallback", () => {
  // Given
  const config = Schema.decodeUnknownSync(ServiceConfig)({ readiness: false });
  // When
  const result = applyAuthoredHealthcheck(web, config);
  // Then
  expect(effectiveReadiness(result)?.kind).toBe("none");
  expect(result.healthcheck).toEqual(native);
  expect(result.readinessSource).toBe("authored");
});

test("timing-only readiness inherits its own stronger command", () => {
  // Given
  const config = Schema.decodeUnknownSync(ServiceConfig)({ readiness: { timeoutSeconds: 9 } });
  // When
  const result = applyAuthoredHealthcheck(web, config);
  // Then
  expect(result.readiness).toEqual({ ...strong, timeoutSeconds: 9 });
  expect(result.healthcheck).toEqual(native);
});

test("authored host readiness drops a contributed container identity", async () => {
  // Given
  const contributed = { ...web, readiness: { ...strong, user: ContainerUser.make("root") } };
  const config = Schema.decodeUnknownSync(ServiceConfig)({
    readiness: { target: "host", command: "test -f .ready" },
  });
  // When
  const service = applyAuthoredHealthcheck(contributed, config);
  const validation = await Effect.runPromise(
    Effect.result(validateServiceProbes({ ...plan, services: { [service.name]: service } })),
  );
  // Then
  expect(service.readiness?.executionTarget).toBe("host");
  expect(service.readiness?.user).toBeUndefined();
  expect(Result.isSuccess(validation)).toBe(true);
});

test.each([
  { user: "root", command: ["true"] },
  { target: "host", disable: true },
  { user: "root", disable: true },
])("native execution metadata rejects even disabled checks: %j", async (healthcheck) => {
  // Given
  const config = Schema.decodeUnknownSync(ServiceConfig)({ healthcheck });
  const service = applyAuthoredHealthcheck(web, config);
  // When
  const result = await Effect.runPromise(
    Effect.result(validateServiceProbes({ ...plan, services: { [service.name]: service } })),
  );
  // Then
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) expect(result.failure._tag).toBe("HealthcheckTargetUnsupportedError");
});

test("active missing command is a validation failure", async () => {
  // Given
  const config = Schema.decodeUnknownSync(ServiceConfig)({ readiness: {} });
  const { readiness: _readiness, healthcheck: _healthcheck, ...bare } = web;
  const service = applyAuthoredHealthcheck(bare, config);
  // When
  const result = await Effect.runPromise(
    Effect.result(validateServiceProbes({ ...plan, services: { [service.name]: service } })),
  );
  // Then
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) expect(result.failure._tag).toBe("LandofileValidationError");
});

test("disabled native health does not silently disable an authored readiness object", async () => {
  // Given
  const config = Schema.decodeUnknownSync(ServiceConfig)({
    healthcheck: false,
    readiness: { timeoutSeconds: 1 },
  });
  const { readiness: _readiness, ...bare } = web;
  const service = applyAuthoredHealthcheck(bare, config);
  // When
  const result = await Effect.runPromise(
    Effect.result(validateServiceProbes({ ...plan, services: { [service.name]: service } })),
  );
  // Then
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) expect(result.failure._tag).toBe("LandofileValidationError");
});

test("native health rejects an explicit user even when it matches the service identity", async () => {
  // Given
  const config = Schema.decodeUnknownSync(ServiceConfig)({
    user: "root",
    healthcheck: { command: "true", user: "root" },
  });
  const service = applyAuthoredHealthcheck({ ...web, user: "root" }, config);
  // When
  const result = await Effect.runPromise(
    Effect.result(validateServiceProbes({ ...plan, services: { [service.name]: service } })),
  );
  // Then
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) expect(result.failure._tag).toBe("HealthcheckTargetUnsupportedError");
});
