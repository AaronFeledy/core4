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
      "Your application owns this listener. Lando sets `PORT` and `NODE_PORT` to 3000; make its server listen on 0.0.0.0:3000.",
  },
  {
    authority: { owner: "launcher", daemon: "node", port: 3000, setting: "--port 3000" },
    sentence:
      "Lando configures the listener from port: only in its own launcher. Your command or entrypoint must configure it: for node, pass `--port 3000`.",
  },
  {
    authority: { owner: "image", daemon: "nginx", port: 3000, setting: "listen 3000", file: "nginx.conf" },
    sentence:
      "Lando configures the listener from port: only in configuration it owns. Your image or build must configure it: for nginx, set `listen 3000` in nginx.conf.",
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
    `${authority.owner} authority is appended only to an unbound or loopback action: %s`,
    (state) => {
      const advised = { ...service, listenerAuthority: authority };
      const diagnostic = listenerDiagnostic(observation(state), advised);
      expect(diagnostic.action).toBe(
        state === "listening" ? actions[state] : `${actions[state]} ${sentence}`,
      );
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
  },
);
