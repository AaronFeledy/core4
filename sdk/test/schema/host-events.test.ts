import { expect, test } from "bun:test";
import { Result, Schema } from "effect";

import {
  HOST_EVENT_NAMES,
  HostEventStep,
  HostEvents,
  JSON_SCHEMA_NAMES,
  LANDO_HOST_EVENT_ENV,
  LIFECYCLE_COMMAND_IDS,
  formatHostEventsIssueMessage,
  hostEventStepLocation,
  hostEventsConfigIssues,
  hostEventsSemanticIssues,
  isHostEventContainerStep,
  isLifecycleCommandId,
  resolveLifecycleCommandId,
} from "@lando/sdk/schema";

test("registers hostEvents schemas for snapshot generation", () => {
  expect(JSON_SCHEMA_NAMES).toContain("HostEvents");
  expect(JSON_SCHEMA_NAMES).toContain("HostEventStep");
  expect(JSON_SCHEMA_NAMES).toContain("LifecycleCommandId");
});

test("accepts the v1 scalar step shapes and rejects extra fields", () => {
  expect(Schema.decodeUnknownSync(HostEventStep)("echo host")).toBe("echo host");
  expect(Schema.decodeUnknownSync(HostEventStep)({ cmd: "echo host", service: ":host" })).toEqual({
    cmd: "echo host",
    service: ":host",
  });
  expect(Schema.decodeUnknownSync(HostEventStep)({ command: "info" })).toEqual({ command: "info" });
  expect(Result.isFailure(Schema.decodeUnknownResult(HostEventStep)({ cmd: "echo", env: { A: "1" } }))).toBe(
    true,
  );
  expect(Result.isFailure(Schema.decodeUnknownResult(HostEventStep)({ cmd: "echo", task: "nope" }))).toBe(
    true,
  );
  expect(
    Result.isFailure(Schema.decodeUnknownResult(HostEventStep)({ command: "info", flags: { json: true } })),
  ).toBe(true);
});

test("rejects unknown hostEvents keys and forbidden container steps at load", () => {
  const decoded = Schema.decodeUnknownResult(HostEvents)(
    { "pre-start": [{ cmd: "echo host", service: ":host" }], extra: [] },
    { onExcessProperty: "error" },
  );
  expect(Result.isFailure(decoded)).toBe(true);

  const issues = hostEventsSemanticIssues({
    "pre-start": ["echo container", { cmd: "echo host", service: ":host" }],
    "post-stop": [{ cmd: "echo gone" }],
    "post-destroy": [{ command: "info" }],
  });
  expect(issues.map((issue) => issue.path)).toEqual([
    ["hostEvents", "pre-start", 0],
    ["hostEvents", "post-stop", 0],
  ]);
  expect(issues[0]?.message).toContain(hostEventStepLocation("pre-start", 0));
});

test("rejects lifecycle command steps after alias resolve", () => {
  const issues = hostEventsSemanticIssues({
    "post-start": [
      { command: "start" },
      { command: "app:destroy" },
      { command: "poweroff" },
      { command: "info" },
    ],
  });
  expect(issues.map((issue) => issue.message)).toEqual([
    `${hostEventStepLocation("post-start", 0)} cannot run lifecycle command app:start.`,
    `${hostEventStepLocation("post-start", 1)} cannot run lifecycle command app:destroy.`,
    `${hostEventStepLocation("post-start", 2)} cannot run lifecycle command apps:poweroff.`,
  ]);
});

test("resolves lifecycle command aliases onto the sdk id list", () => {
  expect(LANDO_HOST_EVENT_ENV).toBe("LANDO_HOST_EVENT");
  expect(HOST_EVENT_NAMES).toHaveLength(10);
  expect(resolveLifecycleCommandId("restart")).toBe("app:restart");
  expect(isLifecycleCommandId("destroy")).toBe(true);
  expect(isLifecycleCommandId("app:start")).toBe(true);
  expect(isLifecycleCommandId("info")).toBe(false);
  expect(LIFECYCLE_COMMAND_IDS).toEqual([
    "app:start",
    "app:stop",
    "app:restart",
    "app:rebuild",
    "app:destroy",
    "apps:poweroff",
  ]);
  expect(resolveLifecycleCommandId("poweroff")).toBe("apps:poweroff");
  expect(isLifecycleCommandId("poweroff")).toBe(true);
});

test("prefixes load issues with config.yml hostEvents.<event>[i] and the bad key", () => {
  const unknownEvent = hostEventsConfigIssues({ "pre-strat": [{ cmd: "echo host", service: ":host" }] });
  expect(unknownEvent[0]?.message).toContain("config.yml hostEvents.pre-strat");
  expect(unknownEvent[0]?.message).toContain('rejects "pre-strat"');

  const forbiddenField = hostEventsConfigIssues({
    "post-start": [{ cmd: "echo host", service: ":host", env: { A: "1" } }],
  });
  const envIssue = forbiddenField.at(0);
  expect(envIssue).toBeDefined();
  if (envIssue === undefined) throw new Error("expected hostEvents env issue");
  expect(envIssue.message).toContain("config.yml hostEvents.post-start[0]");
  expect(envIssue.message).toContain('rejects "env"');
  expect(formatHostEventsIssueMessage(envIssue)).toContain('rejects "env"');
});

test("treats omitted-service strings as container steps", () => {
  expect(isHostEventContainerStep("echo")).toBe(true);
  expect(isHostEventContainerStep({ cmd: "echo", service: "web" })).toBe(true);
  expect(isHostEventContainerStep({ cmd: "echo", service: ":host" })).toBe(false);
  expect(isHostEventContainerStep({ command: "info" })).toBe(false);
});
