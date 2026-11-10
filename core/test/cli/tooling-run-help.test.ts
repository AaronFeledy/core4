import { expect, test } from "bun:test";
import type { ToolingRunSummary, ToolingRunTarget } from "@lando/sdk/schema";
import { renderToolingHelp } from "../../src/cli/cli-help.ts";

const targets: readonly { readonly target: ToolingRunTarget; readonly text: string }[] = [
  { target: { kind: "host" }, text: "on the host" },
  { target: { kind: "primary" }, text: "in the primary service" },
  { target: { kind: "service", name: "web" }, text: "in web" },
  { target: { kind: "flag", flag: "service" }, text: "in the service named by --service" },
  { target: { kind: "dynamic" }, text: "in a dynamically selected service" },
];
test.each(targets)("describes a single command $text before the ownership hint", ({ target, text }) => {
  const help = renderToolingHelp({
    id: "app:check",
    summary: "Check",
    runs: {
      kind: "commands",
      steps: 1,
      targets: [target],
      program: "echo",
    },
  });
  expect(help).toContain(`Runs \`echo\` ${text}.\n\nRun \`lando check -- --help\``);
});

const cases: readonly { readonly runs: ToolingRunSummary; readonly sentence: string }[] = [
  {
    runs: { kind: "commands", steps: 1, targets: [{ kind: "primary" }] },
    sentence: "Runs a command in the primary service.",
  },
  {
    runs: {
      kind: "commands",
      steps: 3,
      targets: [
        { kind: "service", name: "web" },
        { kind: "service", name: "database" },
      ],
    },
    sentence: "Runs 3 commands in web and database.",
  },
  {
    runs: {
      kind: "commands",
      steps: 3,
      targets: [
        { kind: "service", name: "a" },
        { kind: "service", name: "b" },
        { kind: "service", name: "c" },
      ],
    },
    sentence: "Runs 3 commands in a, b, and c.",
  },
  {
    runs: { kind: "commands", steps: 2, targets: [{ kind: "host" }, { kind: "service", name: "web" }] },
    sentence: "Runs 2 commands on the host and in web.",
  },
  {
    runs: { kind: "commands", steps: 3, targets: [{ kind: "host" }] },
    sentence: "Runs 3 commands on the host.",
  },
  {
    runs: { kind: "script", path: ".lando/scripts/deploy.bun.sh" },
    sentence: "Runs .lando/scripts/deploy.bun.sh on the host.",
  },
  {
    runs: { kind: "script", path: ".lando/scripts/evil\u001b[2J.bun.sh" },
    sentence: "Runs .lando/scripts/evil\\u001b[2J.bun.sh on the host.",
  },
];
test.each(cases)("renders $sentence", ({ runs, sentence }) => {
  expect(renderToolingHelp({ id: "app:check", summary: "Check", runs })).toContain(sentence);
});
