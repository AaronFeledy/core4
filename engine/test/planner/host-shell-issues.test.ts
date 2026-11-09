import { expect, test } from "bun:test";
import { rememberInternalToolingTasks } from "@lando/landofile/tooling-include-provenance";
import { parseExpressionEither } from "@lando/sdk/expressions";
import { Result } from "effect";
import { hostShellIssues, planningHostShellIssues } from "../../src/planner/host-shell-issues.ts";

const resolution = (landofile: Parameters<typeof hostShellIssues>[0]["landofile"]) => ({
  landofile,
  pendingSites: [],
  services: [],
});

test.each([":host", "web"])("checks vars.sh only for host task targets (%s)", (service) => {
  const landofile = { tooling: { t: { service, cmd: "echo body", vars: { V: { sh: "echo ${HOME}" } } } } };
  const issues = hostShellIssues(resolution(landofile), []);
  expect(issues.map((issue) => [issue.rule, issue.path])).toEqual(
    service === ":host" ? [["landofile.host-shell", ["tooling", "t", "vars", "V", "sh"]]] : [],
  );
  expect(planningHostShellIssues(resolution(landofile), [])).toEqual([]);
});

test("lints internal include tasks, which still run from event and task steps", () => {
  // Given a hidden include task that uses POSIX-only syntax
  const landofile = rememberInternalToolingTasks(
    { name: "hidden-task", tooling: { hidden: { service: ":host", cmd: "echo ${X}" } } },
    ["hidden"],
  );
  // When
  const issues = hostShellIssues(resolution(landofile), []);
  // Then
  expect(issues.map((issue) => [issue.rule, issue.path])).toEqual([
    ["landofile.host-shell", ["tooling", "hidden", "cmd"]],
  ]);
});

test("planning keeps lifecycle host steps and drops tooling and task hooks", () => {
  // Given
  const landofile = {
    name: "planning-subset",
    tooling: { deploy: { service: ":host", cmd: "echo $?" } },
    events: {
      "pre-start": [{ service: ":host", cmd: "echo hi >&2" }],
      "pre-deploy": [{ service: ":host", cmd: "echo $?" }],
    },
  };
  // When
  const all = hostShellIssues(resolution(landofile), []);
  const planning = planningHostShellIssues(resolution(landofile), []);
  // Then
  expect(all.map((issue) => issue.path)).toEqual([
    ["tooling", "deploy", "cmd"],
    ["events", "pre-start", 0, "cmd"],
    ["events", "pre-deploy", 0, "cmd"],
  ]);
  expect(planning.map((issue) => issue.path)).toEqual([["events", "pre-start", 0, "cmd"]]);
});

test("reads tooling steps through the normalizer, so step services decide what runs on the host", () => {
  // Given a host task with a container step, and a container task with a host step
  const landofile = {
    name: "step-services",
    tooling: {
      mixed: {
        service: ":host",
        cmds: ["echo ${A}", { cmd: "echo ${B}", service: "web" }, { cmd: "echo ${C}" }],
      },
      container: { service: "web", cmds: [{ cmd: "echo ${D}", service: ":host" }, "echo ${E}"] },
      argv: { service: ":host", cmd: ["echo", "${F}"] },
    },
  };
  // When
  const paths = hostShellIssues(resolution(landofile), []).map((issue) => issue.path);
  // Then
  expect(paths).toEqual([
    ["tooling", "container", "cmds", 0, "cmd"],
    ["tooling", "mixed", "cmds", 0],
    ["tooling", "mixed", "cmds", 2, "cmd"],
  ]);
});

test("skips a command only when a {{ }} site will change its text", () => {
  // Given a literal site and an interpolation site on two host tasks
  const landofile = {
    name: "sites",
    tooling: {
      literal: { service: ":host", cmd: "echo ${A}" },
      dynamic: { service: ":host", cmd: "echo {{ args.name }} >&2" },
    },
  };
  const site = (path: string[], text: string) => ({
    path,
    template: Result.getOrThrow(
      parseExpressionEither(text, { filePath: "x", bareShellParameters: "preserve" }),
    ),
  });
  const sites = [
    site(["tooling", "literal", "cmd"], "echo ${A}"),
    site(["tooling", "dynamic", "cmd"], "echo {{ args.name }} >&2"),
  ];
  // When
  const paths = hostShellIssues(resolution(landofile), sites).map((issue) => issue.path);
  // Then
  expect(paths).toEqual([["tooling", "literal", "cmd"]]);
});
