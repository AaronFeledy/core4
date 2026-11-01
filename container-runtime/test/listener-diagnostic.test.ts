import { expect, test } from "bun:test";
import {
  type ListenerAuthority,
  type ListenerObservation,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { DateTime } from "effect";
import { listenerAuthorityAction, listenerDiagnostic } from "../src/listener-diagnostic.ts";

const service: ServicePlan = {
  name: ServiceName.make("app"),
  type: "node",
  provider: ProviderId.make("lando"),
  primary: true,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  environment: {},
  mounts: [],
  endpoints: [{ _tag: "internal", protocol: "http", port: 3000, primary: true }],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  extensions: {},
  metadata: { resolvedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"), source: "test", runtime: 4 },
};
const authorities: ReadonlyArray<{ readonly authority: ListenerAuthority; readonly sentence: string }> = [
  {
    authority: { owner: "application", daemon: "node", port: 3000, variables: ["PORT", "NODE_PORT"] },
    sentence:
      "Make your server listen on 0.0.0.0:3000; your application owns this listener and Lando sets `PORT` and `NODE_PORT` to 3000.",
  },
  {
    authority: { owner: "launcher", daemon: "node", port: 3000, setting: "--port 3000" },
    sentence:
      "Pass `--port 3000` to node in your command or entrypoint; Lando sets the listener from port: only in its own launcher.",
  },
  {
    authority: { owner: "image", daemon: "nginx", port: 3000, setting: "listen 3000", file: "nginx.conf" },
    sentence:
      "Set `listen 3000` in nginx.conf for nginx in your image or build; Lando sets the listener from port: only in configuration it owns.",
  },
];
const observation = (state: ListenerObservation["state"]): ListenerObservation => ({
  service: "app",
  port: 3000,
  transport: "tcp",
  basis: "primary-endpoint",
  state,
  listening:
    state === "not-listening"
      ? []
      : [{ port: 3000, address: state === "loopback-only" ? "127.0.0.1" : "0.0.0.0" }],
});
const actions = {
  "not-listening": "Make app listen on 3000.",
  "loopback-only": "Bind it to all interfaces (0.0.0.0) instead of loopback.",
  listening: "Check the readiness command; its last output is under lastStatus.",
};

test.each(authorities)("formats standalone $authority.owner ownership advice", ({ authority, sentence }) => {
  const advised = { ...service, listenerAuthority: authority };
  const action = listenerAuthorityAction(advised);
  expect(action).toBe(sentence);
});

test.each([undefined, service])("omits standalone advice when authority is absent: %j", (planned) => {
  expect(listenerAuthorityAction(planned)).toBeUndefined();
});

for (const { authority, sentence } of authorities) {
  test.each(["not-listening", "loopback-only", "listening"] as const)(
    `${authority.owner} authority is separate from an unbound or loopback action: %s`,
    (state) => {
      const advised = { ...service, listenerAuthority: authority };
      const diagnostic = listenerDiagnostic(observation(state), advised);
      expect(diagnostic.action).toBe(actions[state]);
      expect(diagnostic.authority).toBe(state === "listening" ? undefined : sentence);
    },
  );
}

test.each(["not-listening", "loopback-only", "listening"] as const)(
  "omits mismatched-port authority for %s",
  (state) => {
    const advised = {
      ...service,
      listenerAuthority: { owner: "launcher" as const, daemon: "node", port: 9000, setting: "--port 9000" },
    };
    const diagnostic = listenerDiagnostic(observation(state), advised);
    expect(diagnostic.action).toBe(actions[state]);
    expect(diagnostic.authority).toBeUndefined();
  },
);

test("a bound scan endpoint gets network advice without readiness or authority advice", () => {
  const diagnostic = listenerDiagnostic(
    observation("listening"),
    {
      ...service,
      listenerAuthority: { owner: "application", daemon: "node", port: 3000, variables: ["PORT"] },
    },
    "scan",
  );
  expect(diagnostic).toEqual({
    finding: "TCP 3000 has a non-loopback binding, but this endpoint remains unreachable",
    action: "Check the network path and HTTP/TLS configuration for this endpoint.",
  });
});
