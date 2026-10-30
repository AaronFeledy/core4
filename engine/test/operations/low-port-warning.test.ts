import { expect, test } from "bun:test";
import { MessageWarnEvent } from "@lando/sdk/events";
import { PortablePath, ServiceName } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { CommandWarnings, makeCommandWarnings } from "../../src/landofile/command-warnings.ts";
import { publishLowPortWarnings, selectLowPortWarnings } from "../../src/operations/low-port-warning.ts";
import { EventPublicationObserver, layer } from "../../src/services/event-service.ts";
import { plan, web } from "./start-progress-topology-support.ts";

const lowPortService = {
  ...web,
  user: "www-data",
  endpoints: [{ _tag: "internal" as const, protocol: "http" as const, port: 80 }],
};
const lowPortPlan = { ...plan, services: { web: lowPortService } };

for (const user of [undefined, "", "root", "root:group", "0", "0:group", "00", "000:1000"]) {
  test(`omits the advisory when the explicit identity is root or absent (${user})`, () => {
    // Given
    const { user: _user, ...service } = lowPortService;
    const input = { ...plan, services: { web: { ...service, ...(user === undefined ? {} : { user }) } } };
    // When
    const warnings = selectLowPortWarnings(input);
    // Then
    expect(warnings).toEqual([]);
  });
}

for (const user of ["www-data", "rootless", "1000", "1000:0", "www-data:root"]) {
  test(`reports unknown permission when the configured identity is ${user}`, () => {
    // Given
    const input = { ...plan, services: { web: { ...lowPortService, user } } };
    // When
    const warnings = selectLowPortWarnings(input);
    // Then
    expect(warnings.map(({ code, context }) => ({ code, context }))).toEqual([
      {
        code: "LANDO_NONROOT_LOW_PORT_UNVERIFIED",
        context: { service: "web", provider: "lando", user, port: "80", policy: "unknown" },
      },
    ]);
  });
}

for (const port of [1024, 8080, 65535]) {
  test(`ignores low published host ports when the container listener is ${port}`, () => {
    // Given
    const input = {
      ...plan,
      services: {
        web: {
          ...lowPortService,
          endpoints: [
            { _tag: "published" as const, protocol: "http" as const, port, publication: { hostPort: 80 } },
          ],
        },
      },
    };
    // When
    const warnings = selectLowPortWarnings(input);
    // Then
    expect(warnings).toEqual([]);
  });
}

test("deduplicates aliases and publications per service port, not across services", () => {
  // Given
  const input = {
    ...plan,
    services: {
      web: {
        ...lowPortService,
        endpoints: [
          { _tag: "internal" as const, protocol: "http" as const, port: 80, name: "http" },
          { _tag: "internal" as const, protocol: "http" as const, port: 80, name: "alias" },
          {
            _tag: "published" as const,
            protocol: "http" as const,
            port: 80,
            publication: { hostPort: 8080 },
          },
          { _tag: "internal" as const, protocol: "udp" as const, port: 80 },
          { _tag: "internal" as const, protocol: "tcp" as const, port: 1023 },
          {
            _tag: "internal" as const,
            protocol: "unix" as const,
            socketPath: PortablePath.make("/run/web.sock"),
          },
        ],
      },
      second: { ...lowPortService, name: ServiceName.make("second") },
      root: { ...lowPortService, name: ServiceName.make("root"), user: "0:1000" },
    },
  };
  // When
  const warnings = selectLowPortWarnings(input);
  // Then
  expect(warnings.map(({ context }) => [context?.service, context?.port])).toEqual([
    ["web", "80"],
    ["web", "1023"],
    ["second", "80"],
  ]);
});

for (const machineOutput of [true, false]) {
  test(`records the structured warning with human narration only when machine=${machineOutput} is false`, async () => {
    // Given: use the real publication observer seam that collects generic machine warnings.
    const warnings = makeCommandWarnings(machineOutput);
    // When
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* publishLowPortWarnings(lowPortPlan);
        const events = yield* EventService;
        return { warnings: yield* warnings.list, human: yield* events.query("message.warn") };
      }).pipe(
        Effect.provideService(CommandWarnings, warnings),
        Effect.provideService(EventPublicationObserver, (event) => {
          if (!machineOutput || !Schema.is(MessageWarnEvent)(event)) {
            return Effect.void;
          }
          return warnings.add({ code: "LANDO_MESSAGE_WARN", message: event.body });
        }),
        Effect.provide(layer),
      ),
    );
    // Then
    expect(result.warnings.map(({ code, context }) => ({ code, context }))).toEqual([
      {
        code: "LANDO_NONROOT_LOW_PORT_UNVERIFIED",
        context: { service: "web", provider: "lando", user: "www-data", port: "80", policy: "unknown" },
      },
    ]);
    expect(result.human).toHaveLength(machineOutput ? 0 : 1);
  });
}

test("publishes a human advisory when embedding without CommandWarnings", async () => {
  // Given
  const operation = Effect.gen(function* () {
    yield* publishLowPortWarnings(lowPortPlan);
    return yield* (yield* EventService).query("message.warn");
  });
  // When
  const events = await Effect.runPromise(operation.pipe(Effect.provide(layer)));
  // Then
  expect(events).toHaveLength(1);
});
