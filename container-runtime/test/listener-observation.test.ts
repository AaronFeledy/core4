import { expect, test } from "bun:test";
import { ProviderId, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import { Cause, DateTime, Effect, Exit, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { listenerDiagnostic } from "../src/listener-diagnostic.ts";
import {
  LISTENER_COMMAND,
  LISTENER_MAX_BYTES,
  expectedTcpListener,
  observeTcpListener,
} from "../src/listener-observation.ts";
import { classifyTcpListeners, parseTcpListeners } from "../src/listener-parser.ts";

const header =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n";
const row = (address: string, port = "18EB", state = "0A") =>
  `0: ${address}:${port} ${"0".repeat(address.length)}:0000 ${state} 00000000:00000000 00:00000000 00000000 0 0 1\n`;
const service: ServicePlan = {
  name: ServiceName.make("cache"),
  type: "redis",
  provider: ProviderId.make("lando"),
  primary: true,
  artifact: { kind: "ref", ref: "redis:7-alpine" },
  environment: {},
  mounts: [],
  endpoints: [{ _tag: "internal", protocol: "tcp", port: 6380, primary: true }],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  extensions: {},
  metadata: { resolvedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"), source: "test", runtime: 4 },
};
const expected = { service: "cache", port: 6380, transport: "tcp", basis: "primary-endpoint" } as const;
const output = (stdout: string) =>
  Stream.make({ kind: "stdout" as const, chunk: new TextEncoder().encode(stdout) }, { exitCode: 1 });

test.each([
  ["00000000", "0.0.0.0", "listening"],
  ["0100007F", "127.0.0.1", "loopback-only"],
  ["0302017F", "127.1.2.3", "loopback-only"],
  ["FFFFFF7F", "127.255.255.255", "loopback-only"],
  ["0100007E", "126.0.0.1", "listening"],
  ["00000000000000000000000001000000", "::1", "loopback-only"],
  ["0000000000000000FFFF00000100007F", "::ffff:7f00:1", "loopback-only"],
  ["0000000000000000FFFF00000302017F", "::ffff:7f01:203", "loopback-only"],
  ["00000000000000000000000000000000", "::", "listening"],
  ["B80D0120000000000000000001000000", "2001:db8::1", "listening"],
] as const)("decodes %s as %s with %s", (hex, address, state) => {
  const bindings = parseTcpListeners(header + row(hex, "18EC"));
  expect(bindings).toEqual([{ address, port: 6380, loopback: state === "loopback-only" }]);
  expect(classifyTcpListeners(expected, bindings ?? []).state).toBe(state);
});

test.each([
  "",
  "garbage\n",
  "sl local_address rem_address st \n",
  `${header}garbage\n`,
  header + row("00000000").trimEnd(),
  `${header}0: 00000000:18EB 00000000:0000 0A\n`,
  header + row("ZZZZZZZZ"),
])("treats invalid or truncated input as unavailable: %j", (text) => {
  expect(parseTcpListeners(text)).toBeUndefined();
});

test("keeps only distinct LISTEN bindings from both tables", () => {
  const bindings = parseTcpListeners(
    header + row("00000000") + row("00000000") + header + row("0100007F", "18EC", "01"),
  );
  expect(bindings).toEqual([{ address: "0.0.0.0", port: 6379, loopback: false }]);
  expect(classifyTcpListeners(expected, bindings ?? [])).toMatchObject({
    state: "not-listening",
    listening: [{ address: "0.0.0.0", port: 6379 }],
  });
});

test("accepts a valid empty table without treating empty stdout as evidence", () => {
  expect(classifyTcpListeners(expected, parseTcpListeners(header) ?? []).state).toBe("not-listening");
});

test("classifies before bounding the list and allows a non-loopback sibling binding", () => {
  const bindings = Array.from({ length: 20 }, (_, port) => ({ port, address: "0.0.0.0", loopback: false }));
  const result = classifyTcpListeners(expected, [
    ...bindings,
    { port: 6380, address: "127.0.0.1", loopback: true },
    { port: 6380, address: "0.0.0.0", loopback: false },
  ]);
  expect(result.state).toBe("listening");
  expect(result.listening).toHaveLength(16);
});

test("selects a probe target before a deduplicated primary endpoint", () => {
  expect(
    expectedTcpListener({
      ...service,
      readiness: {
        kind: "command",
        command: ["check"],
        target: { port: 9000, transport: "tcp", names: [], primary: false },
        intervalSeconds: 0,
        timeoutSeconds: 1,
        retries: 1,
      },
    }),
  ).toMatchObject({ port: 9000, basis: "probe-target" });
  expect(
    expectedTcpListener({
      ...service,
      endpoints: [
        ...service.endpoints,
        { _tag: "published", protocol: "tcp", port: 6380, publication: {}, primary: true },
      ],
    }),
  ).toEqual(expected);
});

test.each([
  { ...service, endpoints: [] },
  { ...service, endpoints: [{ _tag: "internal", protocol: "udp", port: 6380, primary: true }] },
  {
    ...service,
    endpoints: [...service.endpoints, { _tag: "internal", protocol: "http", port: 80, primary: true }],
  },
  {
    ...service,
    readiness: {
      kind: "command",
      command: ["test"],
      executionTarget: "host",
      intervalSeconds: 0,
      timeoutSeconds: 1,
      retries: 1,
    },
  },
] satisfies readonly ServicePlan[])("skips ineligible selection %#", (candidate) => {
  expect(expectedTcpListener(candidate)).toBeUndefined();
});

test("collects raw argv and parses stdout on nonzero exit", async () => {
  const result = await Effect.runPromise(
    observeTcpListener(service, (command) => {
      expect(command).toEqual(LISTENER_COMMAND);
      return output(header + row("00000000"));
    }),
  );
  expect(result).toMatchObject({
    ...expected,
    state: "not-listening",
    listening: [{ address: "0.0.0.0", port: 6379 }],
  });
});

test.each(["", "x".repeat(LISTENER_MAX_BYTES + 1)])(
  "omits unavailable or oversized capture %#",
  async (stdout) => {
    expect(await Effect.runPromise(observeTcpListener(service, () => output(stdout)))).toBeUndefined();
  },
);

test("omits failed collection", async () => {
  expect(
    await Effect.runPromise(observeTcpListener(service, () => Stream.fail("missing cat"))),
  ).toBeUndefined();
});

test("times out collection after two seconds and cancels its exec", async () => {
  let released = false;
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        observeTcpListener(service, () =>
          Stream.fromEffect(
            Effect.never.pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  released = true;
                }),
              ),
            ),
          ),
        ),
      );
      yield* TestClock.adjust("2 seconds");
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );
  expect(result).toBeUndefined();
  expect(released).toBe(true);
});

test("preserves interruption", async () => {
  const result = await Effect.runPromiseExit(
    observeTcpListener(service, () => Stream.fromEffect(Effect.interrupt)),
  );
  expect(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause)).toBe(true);
});

test("limits the port-setting suggestion to a typed primary listener and one observed port", () => {
  const observation = classifyTcpListeners(expected, [{ address: "0.0.0.0", port: 6379, loopback: false }]);
  expect(listenerDiagnostic(observation, service).action).toContain("`port: 6379`");
  expect(listenerDiagnostic(observation, { ...service, type: "compose" }).action).not.toContain("`port:");
  expect(listenerDiagnostic({ ...observation, port: 9000 }, service).action).not.toContain("`port:");
});
