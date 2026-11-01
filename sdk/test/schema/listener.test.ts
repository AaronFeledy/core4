import { expect, test } from "bun:test";
import { ServiceNotReadyError, ServiceStartError } from "@lando/sdk/errors";
import {
  CheckResult,
  ListenerAuthority,
  ListenerAuthorityOwner,
  ListenerDiagnosis,
  ListenerStatus,
  ObservedListener,
  ServiceInfo,
  formatListenerAuthority,
  formatListenerDiagnosis,
  listenerRemediation,
} from "@lando/sdk/schema";
import { Result, Schema } from "effect";

const authority = ListenerAuthority.make({
  owner: "application",
  daemon: "python",
  port: 8081,
  variables: ["PORT", "FLASK_RUN_PORT"],
});
const diagnosis = Schema.decodeUnknownSync(ListenerDiagnosis)({
  service: "web",
  endpoint: { port: 8081, transport: "tcp", names: ["http"], primary: true },
  status: "absent",
  observed: [{ address: "0.0.0.0", port: 8080 }],
  truncated: false,
  authority,
});

test.each(["application", "launcher", "image"] as const)("round-trips listener owner %s", (owner) => {
  expect(
    Schema.encodeSync(ListenerAuthorityOwner)(Schema.decodeUnknownSync(ListenerAuthorityOwner)(owner)),
  ).toBe(owner);
});

test.each(["listening", "loopback-only", "absent", "unavailable"] as const)(
  "round-trips listener status %s",
  (status) => {
    expect(Schema.encodeSync(ListenerStatus)(Schema.decodeUnknownSync(ListenerStatus)(status))).toBe(status);
  },
);

test("round-trips structured authority and socket evidence", () => {
  const wire = Schema.encodeSync(ListenerDiagnosis)(diagnosis);
  const decoded = Schema.decodeUnknownSync(ListenerDiagnosis)(wire, { onExcessProperty: "error" });
  expect(decoded).toEqual(diagnosis);
  expect(
    Schema.decodeUnknownSync(ListenerAuthority)(Schema.encodeSync(ListenerAuthority)(authority)),
  ).toEqual(authority);
  const socket = { address: "::1", port: 8081 };
  expect(Schema.encodeSync(ObservedListener)(Schema.decodeUnknownSync(ObservedListener)(socket))).toEqual(
    socket,
  );
});

test.each([
  { daemon: "" },
  { setting: "" },
  { file: "" },
  { variables: [] },
  { variables: [""] },
  { port: 0 },
  { owner: "provider" },
])("rejects invalid listener authority %j", (fields) => {
  expect(Result.isFailure(Schema.decodeUnknownResult(ListenerAuthority)({ ...authority, ...fields }))).toBe(
    true,
  );
});

test("retains listener evidence through startup and readiness errors", () => {
  const start = new ServiceStartError({
    providerId: "lando",
    operation: "start",
    service: "web",
    message: "failed",
    remediation: "Inspect the service.",
    listener: diagnosis,
  });
  const ready = new ServiceNotReadyError({
    providerId: "lando",
    app: "demo",
    service: "web",
    reason: "healthcheck-failed",
    message: "failed",
    remediation: "Inspect the service.",
    listener: diagnosis,
  });
  expect(
    Schema.decodeUnknownSync(ServiceStartError)(Schema.encodeSync(ServiceStartError)(start)).listener,
  ).toEqual(diagnosis);
  expect(
    Schema.decodeUnknownSync(ServiceNotReadyError)(Schema.encodeSync(ServiceNotReadyError)(ready)).listener,
  ).toEqual(diagnosis);
});

test("retains listener data through check and info projections", () => {
  const check = Schema.decodeUnknownSync(CheckResult)({
    id: "http:web:http://localhost/",
    kind: "http",
    service: "web",
    url: "http://localhost/",
    verdict: "service-error",
    listener: diagnosis,
  });
  const info = Schema.decodeUnknownSync(ServiceInfo)({
    app: "demo",
    service: "web",
    api: 4,
    type: "python",
    provider: "lando",
    primary: true,
    status: "running",
    connections: [],
    listenerAuthority: authority,
  });
  expect(Schema.decodeUnknownSync(CheckResult)(Schema.encodeSync(CheckResult)(check)).listener).toEqual(
    diagnosis,
  );
  expect(
    Schema.decodeUnknownSync(ServiceInfo)(Schema.encodeSync(ServiceInfo)(info)).listenerAuthority,
  ).toEqual(authority);
});

test("orders observed absence before application configuration advice", () => {
  expect(listenerRemediation({ diagnosis })).toBe(
    "No TCP listener was observed on planned port 8081. Other TCP listeners: `0.0.0.0:8080`. Your application owns this listener. Lando sets `PORT` and `FLASK_RUN_PORT` to 8081; make its server listen on 0.0.0.0:8081.",
  );
});

test("does not recommend listener changes when a reachable bind is observed", () => {
  expect(
    listenerRemediation({ diagnosis: { ...diagnosis, status: "listening" }, authority }),
  ).toBeUndefined();
});

test("keeps ownership advice without claiming unavailable socket evidence", () => {
  expect(formatListenerDiagnosis({ ...diagnosis, status: "unavailable" })).toBeUndefined();
  expect(listenerRemediation({ diagnosis: { ...diagnosis, status: "unavailable" } })).toBe(
    formatListenerAuthority(authority),
  );
  expect(listenerRemediation({})).toBeUndefined();
});

test("formats launcher and image configuration without attributing sockets", () => {
  expect(
    formatListenerAuthority({ owner: "launcher", daemon: "mongod", port: 27018, setting: "--port 27018" }),
  ).toBe(
    "Lando configures the listener from port: only in its own launcher. Your command or entrypoint must configure it: for mongod, pass `--port 27018`.",
  );
  expect(
    formatListenerAuthority({
      owner: "image",
      daemon: "Tomcat",
      port: 8081,
      setting: '<Connector port="8081">',
      file: "server.xml",
    }),
  ).toBe(
    'Lando configures the listener from port: only in configuration it owns. Your image or build must configure it: for Tomcat, set `<Connector port="8081">` in server.xml.',
  );
});

test("formats loopback-only and empty-table diagnoses", () => {
  expect(
    formatListenerDiagnosis({
      ...diagnosis,
      status: "loopback-only",
      observed: [{ address: "127.0.0.1", port: 8081 }],
    }),
  ).toBe(
    "Port 8081 was observed only on loopback (`127.0.0.1`). Other containers cannot reach it; configure the server to bind 0.0.0.0.",
  );
  expect(formatListenerDiagnosis({ ...diagnosis, observed: [] })).toBe(
    "No TCP listener was observed on planned port 8081. No other TCP listeners were observed.",
  );
});
