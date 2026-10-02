import { expect, test } from "bun:test";
import {
  resolveSshAgentIntent,
  sshAgentExtensionForIntent,
  sshAgentPlanExtension,
} from "../../../src/subsystems/ssh/intent.ts";

test("landofile sidecar false overrides global sidecar true", () => {
  // Given / When
  const intent = resolveSshAgentIntent({
    landofile: { sshAgent: { sidecar: false } },
    globalConfig: { sshAgent: { sidecar: true } },
  });
  // Then
  expect(intent).toEqual({ mode: "host" });
});

test("global socket applies when the landofile omits it", () => {
  // Given / When
  const intent = resolveSshAgentIntent({
    landofile: { sshAgent: { sidecar: false } },
    globalConfig: { sshAgent: { socket: "/global/agent.sock" } },
  });
  // Then
  expect(intent).toEqual({ mode: "host", socket: "/global/agent.sock" });
});

test("landofile socket overrides global socket independently of mode", () => {
  // Given / When
  const intent = resolveSshAgentIntent({
    landofile: { sshAgent: { socket: "/app/agent.sock" } },
    globalConfig: { sshAgent: { sidecar: false, socket: "/global/agent.sock" } },
  });
  // Then
  expect(intent).toEqual({ mode: "host", socket: "/app/agent.sock" });
});

test("defaults to sidecar", () => {
  // Given / When / Then
  expect(resolveSshAgentIntent({ landofile: {} })).toEqual({ mode: "sidecar" });
});

test("plan extension carries only the resolved mode", () => {
  // Given / When
  const extension = sshAgentExtensionForIntent({ mode: "host", socket: "/private/agent.sock" });
  // Then
  expect(extension).toEqual({ mode: "host" });
  expect(sshAgentPlanExtension({ extensions: { "@lando/core/ssh-agent": extension } })).toEqual(extension);
});

test("missing or malformed plan extensions are ignored", () => {
  // Given / When / Then
  for (const extension of [undefined, null, {}, { mode: "invalid" }]) {
    expect(sshAgentPlanExtension({ extensions: { "@lando/core/ssh-agent": extension } })).toBeUndefined();
  }
});
