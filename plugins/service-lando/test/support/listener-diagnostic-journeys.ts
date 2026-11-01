import { expect } from "bun:test";
import { CommandResultEnvelope, ListenerObservation } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { acquireListenerApp, publicationFor } from "./listener-cli.ts";

const doctorResult = Schema.Struct({
  appListeners: Schema.Struct({
    checks: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        status: Schema.String,
        context: Schema.Record(Schema.String, Schema.String),
      }),
    ),
  }),
});
const failedStart = Schema.Struct({
  ok: Schema.Literal(false),
  error: Schema.Struct({
    _tag: Schema.Literal("ServiceNotReadyError"),
    service: Schema.String,
    remediation: Schema.String,
    listener: ListenerObservation,
  }),
});
const resultFrame = Schema.Struct({ _tag: Schema.Literal("result"), envelope: CommandResultEnvelope });
const envelopeFrom = (output: string) => {
  const json: unknown = JSON.parse(output.trim().split("\n").at(-1) ?? "");
  return Schema.is(resultFrame)(json)
    ? Schema.decodeUnknownSync(resultFrame)(json).envelope
    : Schema.decodeUnknownSync(CommandResultEnvelope)(json);
};

export const listenerDiagnosticJourneys = [
  { id: "diagnostic-node-loopback", family: "node", host: "127.0.0.1" },
  { id: "diagnostic-node-wildcard", family: "node", host: "0.0.0.0" },
  { id: "diagnostic-mongodb-authored-command", family: "mongodb" },
] as const;

export const runListenerDiagnosticJourney = Effect.fnUntraced(function* (
  socketPath: string,
  journey: (typeof listenerDiagnosticJourneys)[number],
) {
  const app = yield* acquireListenerApp(socketPath);
  if (journey.family === "mongodb") {
    yield* app.prepare({
      services: {
        subject: {
          type: "mongodb:7",
          port: 27018,
          command: "mongod --bind_ip_all",
          appMount: false,
          home: false,
        },
      },
    });
    const output = yield* app.cli(["start"], 1);
    const failure = Schema.decodeUnknownSync(failedStart)(envelopeFrom(output));
    expect(failure.error.service).toBe("subject");
    expect(failure.error.listener).toMatchObject({ port: 27018, state: "not-listening" });
    expect(failure.error.remediation).toContain("--port 27018");
    return;
  }
  const port = 18080;
  const started = yield* app.start({
    services: {
      subject: {
        type: "node:24",
        port,
        appMount: false,
        home: false,
        ports: [`127.0.0.1::${port}`],
        command: [
          "node",
          "-e",
          `require("http").createServer((req,res) => res.end("diagnostic")).listen(Number(process.env.PORT), "${journey.host}")`,
        ],
      },
    },
  });
  const subject = started.servicesStarted.find((service) => service.name === "subject");
  expect(subject).toBeDefined();
  publicationFor(subject?.connections ?? [], port);
  if (journey.host === "127.0.0.1") {
    expect(started.checks?.filter((check) => check.service === "subject")).toContainEqual(
      expect.objectContaining({ listener: expect.objectContaining({ port, state: "loopback-only" }) }),
    );
  }
  const output = yield* app.cli(["doctor", "--app"]);
  const envelope = envelopeFrom(output);
  expect(envelope.ok).toBe(true);
  const report = Schema.decodeUnknownSync(doctorResult)(envelope.result);
  const checks = report.appListeners.checks.filter(
    (check) =>
      check.name === "app-listener" &&
      check.context.service === "subject" &&
      check.context.port === String(port),
  );
  expect(checks).toHaveLength(1);
  expect(checks[0]).toMatchObject({
    status: journey.host === "127.0.0.1" ? "warn" : "pass",
    context: { listenerState: journey.host === "127.0.0.1" ? "loopback-only" : "listening" },
  });
});
