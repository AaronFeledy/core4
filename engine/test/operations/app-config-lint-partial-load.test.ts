import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigLintResult, ConfigLintViolation } from "@lando/sdk/schema";
import { Effect } from "effect";
import { appConfigLint } from "../../src/operations/app-config-lint.ts";
import * as Plugins from "../../src/plugins/registry.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";

const unavailableService = `services:
  other:
    type: compose
    image: alpine
    environment:
      FOO: "{{ env.UNSET }}"
`;
const badType = "  web:\n    type: no-such-type\n";
type Finding = readonly [ConfigLintViolation["rule"], ConfigLintViolation["path"]];
const missingEnv: Finding = ["landofile.load", ["services", "other", "environment", "FOO"]];
const unsupportedType: Finding = ["landofile.service", ["services", "web", "type"]];
const findings = (result: ConfigLintResult): readonly Finding[] =>
  result.violations.map(({ rule, path }) => [rule, path]);

const lint = async (yaml: string, env: Readonly<Record<string, string>> = {}) => {
  const cwd = await mkdtemp(join(tmpdir(), "lando-lint-partial-"));
  try {
    await writeFile(join(cwd, ".lando.yml"), yaml);
    return await Effect.runPromise(
      appConfigLint({
        cwd,
        templates: { modules: [], context: { env, scope: "test", bootstrapLevel: "minimal" } },
      }).pipe(Effect.provide(Plugins.layer), Effect.provide(makeTestStateStore().layer)),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
};

test.each([
  {
    title: "reports one load violation for each unsupported self-port expression",
    yaml: `services:
  cache:
    type: redis
    port: "{{ service.port }}"
    environment:
      SELF_PORT: "{{ service.port }}"
    command: [redis-server, --port, "{{ service.name }}"]
`,
    expected: [
      ["landofile.load", ["services", "cache", "port"]],
      ["landofile.load", ["services", "cache", "environment", "SELF_PORT"]],
      ["landofile.load", ["services", "cache", "command", 2]],
    ],
  },
  {
    title: "reports an unsupported type alongside an isolated load failure",
    yaml: unavailableService + badType,
    expected: [missingEnv, unsupportedType],
  },
  {
    title: "reports an unsupported type alongside an invalid environment list entry",
    yaml: `services:
  other:
    type: compose
    image: alpine
    environment:
      - NOT_A_PAIR
${badType}`,
    expected: [["landofile.validation", ["services", "other", "environment", 0]], unsupportedType],
  },
  {
    title: "does not evaluate credentials of a service blocked during loading",
    yaml:
      unavailableService +
      badType +
      `  reader:
    type: compose
    image: alpine
    environment:
      DB_USER: "{{ services.other.creds.user }}"
`,
    expected: [missingEnv, unsupportedType],
  },
  {
    title: "counts an unavailable proxy target as declared",
    yaml: `${unavailableService}proxy:\n  other: [other.demo.lndo.site]\n`,
    expected: [missingEnv],
  },
  {
    title: "does not diagnose the readiness parent of an unavailable command",
    yaml: `services:
  web:
    type: compose
    image: alpine
    readiness:
      target: host
      kind: command
      command: "{{ env.PROBE }}"
`,
    expected: [["landofile.load", ["services", "web", "readiness", "command"]]],
  },
  {
    title: "does not assume ownership of a network with unavailable external status",
    yaml: `networks:
  shared:
    name: shared
    external: "{{ env.EXT }}"
`,
    expected: [["landofile.load", ["networks", "shared", "external"]]],
  },
  {
    title: "does not infer a collision from a deferred network name on the first declaration",
    yaml: `${unavailableService}  web:
    type: compose
    image: alpine
    networks:
      first: {}
      second: {}
networks:
  first:
    name: "{{ services.other.creds.user }}"
    external: true
  second:
    name: "{{{{ services.other.creds.user }}"
    external: true
`,
    expected: [missingEnv],
  },
  {
    title: "does not scan Bun Shell syntax in an unresolved probe command",
    yaml: `${unavailableService}  web:
    type: compose
    image: alpine
    readiness:
      target: host
      command: "test -f $\u0024{READY} {{ services.other.creds.user }}"
`,
    expected: [missingEnv],
  },
  {
    title: "keeps fragment checks but does not assume the contents of a missing include",
    yaml: `includes: [./missing.yml]\nservices:\n${badType}    wrongkey: true\n`,
    expected: [
      ["landofile.validation", ["services", "web", "wrongkey"]],
      ["landofile.load", ["includes", 0]],
    ],
  },
])("$title", async ({ yaml, expected }) => {
  const result = await lint(`name: demo\n${yaml}`);
  expect(result.valid).toBe(false);
  expect(findings(result)).toEqual(expected);
});

test("resumes the clean load path once the environment value is supplied", async () => {
  const yaml = `name: demo\n${unavailableService}${badType}`;
  const result = await lint(yaml, { UNSET: "fixed" });
  expect(result.valid).toBe(false);
  expect(findings(result)).toEqual([unsupportedType]);
  expect(result.skipped).toMatchObject([{ stage: "planning", reason: "earlier-errors" }]);
});

test("reports one unavailable entry with its authored cause and omits final planning", async () => {
  const result = await lint(`name: demo\n${unavailableService}${badType}`);
  expect(result.skipped).toMatchObject([
    {
      stage: "resolve",
      reason: "unavailable",
      path: ["services", "other"],
      source: { file: result.file, layer: "canonical", path: missingEnv[1] },
    },
    { stage: "planning", reason: "diagnostic-document" },
  ]);
});

test("reports the missing include as the cause of the effective and resolve omission", async () => {
  const result = await lint(`name: demo\n${unavailableService}includes: [./missing.yml]\n`);
  expect(result.skipped).toMatchObject([
    {
      stage: "effective",
      reason: "load-failure",
      source: { file: result.file, layer: "canonical", path: ["includes", 0] },
    },
  ]);
});

test("checks the derived internal name even when a service field is blocked", async () => {
  const key = Array.from({ length: 4 }, () => "a".repeat(62)).join(".");
  const result = await lint(`name: demo\n${unavailableService.replace("  other:", `  ${key}:`)}`);
  expect(findings(result)).toEqual([
    ["landofile.load", ["services", key, "environment", "FOO"]],
    ["landofile.dns-name", ["services", key]],
  ]);
});

test("does not resolve effective checks without an established app name", async () => {
  const result = await lint(`name: "{{ env.APP_NAME }}"\nservices:\n${badType}`);
  expect(result.valid).toBe(false);
  expect(findings(result)).toEqual([["landofile.load", ["name"]]]);
});

const brokenSeeds = `name: demo
services:
  raw:
    type: lando
    image: busybox:1.37
    command: [sleep, "{{ service.port }}"]
  php:
    type: php:8.4
    via: cli
    command: [php, -S, "0.0.0.0:{{ service.port }}"]
  reader:
    type: lando
    image: busybox:1.37
    environment:
      FIRST: "{{ services.raw.port }}"
      SECOND: "{{ services.php.port }}"
`;
const rawCommand = ["services", "raw", "command", 1];
const seedFindings: readonly Finding[] = [
  ["landofile.expression", rawCommand],
  ["landofile.expression", ["services", "php", "command", 2]],
];

test("reports independent expression failures, skips dependents once, and still checks a route sibling", async () => {
  const result = await lint(`${brokenSeeds}proxy:
  reader:
    - hostname: "{{ services.reader.port }}.lndo.site"
      pathPrefix: no-slash
`);

  expect(findings(result)).toEqual([
    ...seedFindings,
    ["landofile.route", ["proxy", "reader", 0, "pathPrefix"]],
  ]);
  expect(result.skipped).toMatchObject([
    { stage: "resolve", reason: "unavailable", path: ["services", "reader"], source: { path: rawCommand } },
    { stage: "resolve", reason: "unavailable", path: ["proxy", "reader"], source: { path: rawCommand } },
    { stage: "planning", reason: "earlier-errors" },
  ]);
});

test.each(["services.missing.port", "services[app.name].port"])(
  "preserves seed findings when %s aborts whole-document resolution",
  async (reference) => {
    const result = await lint(`${brokenSeeds}tooling:
  blocked:
    service: ":host"
    cmd: "echo {{ services.reader.port }} {{ flags.name }}"
  broken:
    cmd: "echo {{ ${reference} }}"
`);

    const path = ["tooling", "broken", "cmd"];
    expect(findings(result)).toEqual([...seedFindings, ["landofile.expression", path]]);
    expect(result.skipped).toMatchObject([
      { stage: "resolve", reason: "unavailable", path: ["services", "reader"] },
      { stage: "resolve", reason: "unavailable", path: ["tooling", "blocked"] },
      { stage: "resolve", reason: "earlier-errors", path },
      { stage: "planning", reason: "earlier-errors" },
    ]);
  },
);
