import { expect, test } from "bun:test";

import {
  classifySocketProxyArtifacts,
  foreignSocketProxyNotice,
  socketProxyPolkitHeader,
  socketProxyUnitHeader,
} from "../src/socket-proxy-helper.ts";

const root = "/lando/root";
const other = "/lando/other";
const artifacts = (owner: string) => [
  ...Array.from({ length: 4 }, () => socketProxyUnitHeader(owner)),
  socketProxyPolkitHeader(owner),
];

test.each([
  { name: "absent", files: Array.from({ length: 5 }, () => null), roots: [], expected: { kind: "absent" } },
  { name: "owned", files: artifacts(root), roots: [root], expected: { kind: "owned" } },
  {
    name: "conflicting stamps in one file",
    files: [`${socketProxyUnitHeader(root)}\n# lando-data-root: ${JSON.stringify(other)}`],
    roots: [other],
    expected: { kind: "foreign", reason: "mixed" },
  },
  {
    name: "partial owned",
    files: [socketProxyUnitHeader(root), null, null, null, null],
    roots: [],
    expected: { kind: "owned" },
  },
  {
    name: "other root",
    files: artifacts(other),
    roots: [other],
    expected: { kind: "foreign", reason: "other-root", ownerRoot: other },
  },
  {
    name: "missing root",
    files: artifacts(other),
    roots: [],
    expected: { kind: "foreign", reason: "missing-root", ownerRoot: other },
  },
  {
    name: "unattributed",
    files: Array.from({ length: 5 }, () => "# lando-proxy-socket-helper"),
    roots: [],
    expected: { kind: "foreign", reason: "unattributed" },
  },
  {
    name: "mixed roots",
    files: [socketProxyUnitHeader(other), ...artifacts(root).slice(1)],
    roots: [other],
    expected: { kind: "foreign", reason: "mixed" },
  },
  {
    name: "unreadable",
    files: [undefined, ...artifacts(root).slice(1)],
    roots: [],
    expected: { kind: "foreign", reason: "mixed" },
  },
  {
    name: "unmarked",
    files: Array.from({ length: 5 }, () => "user file"),
    roots: [],
    expected: { kind: "unmarked" },
  },
  {
    name: "mixed user files",
    files: ["user file", ...artifacts(root).slice(1)],
    roots: [],
    expected: { kind: "foreign", reason: "mixed" },
  },
  {
    name: "invalid stamp is mixed not unattributed",
    files: Array.from({ length: 5 }, () => "# lando-proxy-socket-helper\n# lando-data-root: broken"),
    roots: [],
    expected: { kind: "foreign", reason: "mixed" },
  },
  {
    name: "empty stamp is mixed",
    files: ["# lando-proxy-socket-helper\n# lando-data-root:"],
    roots: [],
    expected: { kind: "foreign", reason: "mixed" },
  },
  {
    name: "nonabsolute stamp is mixed",
    files: Array.from(
      { length: 5 },
      () => `# lando-proxy-socket-helper\n# lando-data-root: ${JSON.stringify("relative/root")}`,
    ),
    roots: [],
    expected: { kind: "foreign", reason: "mixed" },
  },
])("classifies $name helper artifacts", ({ files, roots, expected }) => {
  expect(classifySocketProxyArtifacts(files, root, roots)).toEqual(expected);
});

test("round trips a root containing quotes and whitespace through both comment formats", () => {
  const owner = '/lando/a "quoted" root';
  expect(classifySocketProxyArtifacts(artifacts(owner), owner, [])).toEqual({ kind: "owned" });
});

test("brief ensure notices omit removal recipes", () => {
  const missing = classifySocketProxyArtifacts(artifacts(other), root, []);
  const brief = foreignSocketProxyNotice(missing, "brief");
  expect(brief).toContain(other);
  expect(brief).not.toContain("sudo");
  const commands = foreignSocketProxyNotice(missing, "commands");
  expect(commands).toContain("sudo systemctl");
});
