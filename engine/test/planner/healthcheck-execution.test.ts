import { expect, test } from "bun:test";
import { HealthcheckTargetUnsupportedError } from "@lando/sdk/errors";
import { ServiceConfig, ServiceName } from "@lando/sdk/schema";
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
const listener = { port: 80, transport: "tcp", names: [], primary: false } as const;
const plan = planWith(
  { web: [] },
  {
    web: {
      healthcheck: { ...native, target: listener },
      readiness: { ...native, command: ["strong"], target: listener },
      endpoints: [{ _tag: "internal", port: 80, protocol: "tcp" }],
    },
  },
);
const web = plan.services[ServiceName.make("web")];
if (web === undefined) throw new TypeError("Missing fixture service");

test.each([
  { command: ["custom"], user: "1001:1002" },
  { command: "test -f ready", target: "host" },
])("authors readiness execution independently of native health", (readiness) => {
  // Given
  const config = Schema.decodeUnknownSync(ServiceConfig)({ type: "test", readiness });
  // When
  const result = applyAuthoredHealthcheck(web, config);
  // Then
  expect(result.healthcheck).toEqual(web.healthcheck);
  expect(result.readiness).toMatchObject({
    command: readiness.command,
    ...("user" in readiness ? { user: readiness.user } : { executionTarget: "host" }),
  });
  expect(result.readiness?.target).toBeUndefined();
});

test("ordinary authored native commands preserve stronger contributed readiness", () => {
  // Given
  const config = Schema.decodeUnknownSync(ServiceConfig)({ type: "test", healthcheck: ["custom"] });
  // When
  const result = applyAuthoredHealthcheck(web, config);
  // Then
  expect(result.readiness).toEqual(web.readiness);
  expect(result.healthcheck?.command).toEqual(["custom"]);
  expect(result.healthcheck?.target).toBeUndefined();
});

test("omitted healthcheck preserves the type-owned native/readiness split", () => {
  // Given
  const config = Schema.decodeUnknownSync(ServiceConfig)({ type: "test" });
  // When
  const result = applyAuthoredHealthcheck(web, config);
  // Then
  expect(result).toBe(web);
});

test("false native health leaves type-owned readiness enabled", () => {
  // Given
  const config = Schema.decodeUnknownSync(ServiceConfig)({ type: "test", healthcheck: false });
  // When
  const result = applyAuthoredHealthcheck(web, config);
  // Then
  expect(result.healthcheck?.kind).toBe("none");
  expect(result.readiness).toEqual(web.readiness);
});

test.each([{ target: "host" }, { target: "host", command: "true", user: "root" }])(
  "rejects unsupported authored host intent instead of inheriting a type command",
  async (healthcheck) => {
    // Given
    const config = Schema.decodeUnknownSync(ServiceConfig)({ type: "test", healthcheck });
    const service = applyAuthoredHealthcheck(web, config);
    // When
    const result = await Effect.runPromise(
      Effect.result(validateServiceProbes({ ...plan, services: { [web.name]: service } })),
    );
    // Then
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(HealthcheckTargetUnsupportedError);
  },
);

test("rejects a host probe carrying a service listener in an already-built plan", async () => {
  // Given
  const service = { ...web, readiness: { ...native, target: listener, executionTarget: "host" as const } };
  // When
  const result = await Effect.runPromise(
    Effect.result(validateServiceProbes({ ...plan, services: { [web.name]: service } })),
  );
  // Then
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) expect(result.failure._tag).toBe("HealthcheckTargetUnsupportedError");
});
