import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { lintLandofileSnapshot } from "../src/lint.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "./support.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-lint-diagnostic-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const lint = () =>
  Effect.runPromise(
    lintLandofileSnapshot(
      { cwd: root },
      {
        ports: makeTestLandofilePorts(root),
        stateStore: makeTestLandofileStateStore(),
        templates: { modules: [], context: { env: {}, scope: "test", bootstrapLevel: "minimal" } },
      },
    ),
  );

test("reports a tooling fragment expression failure without a diagnostic document", async () => {
  await writeFile(
    join(root, ".lando.yml"),
    "name: demo\ntoolingIncludes:\n  tools:\n    file: ./tools.yml\n",
  );
  await writeFile(join(root, "tools.yml"), 'tooling:\n  check:\n    cmd: "{{ env.UNSET }}"\n');

  const snapshot = await lint();

  expect(snapshot.resolved).toBeUndefined();
  expect(snapshot.diagnostic).toBeUndefined();
  expect(snapshot.result.valid).toBe(false);
  expect(snapshot.result.violations).toMatchObject([
    {
      rule: "landofile.load",
      reason: "ConfigExpressionError",
      severity: "error",
      path: ["tooling", "check", "cmd"],
      source: { file: join(root, "tools.yml"), path: ["tooling", "check", "cmd"] },
    },
  ]);
});

test("rebases a failed route field after an include contributes an earlier array entry", async () => {
  await writeFile(
    join(root, ".lando.yml"),
    `name: demo
includes: [./routes.yml]
services:
  web:
    routes:
      - hostname: second.demo.lndo.site
        endpoint: "{{ env.UNSET }}"
`,
  );
  await writeFile(
    join(root, "routes.yml"),
    `services:
  web:
    routes:
      - hostname: first.demo.lndo.site
`,
  );

  const snapshot = await lint();

  expect(snapshot.diagnostic?.unavailable.map(({ path }) => path)).toEqual([
    ["services", "web", "routes", 1, "endpoint"],
  ]);
});

test("does not block the winning value when a higher layer shadows the failed origin", async () => {
  await writeFile(join(root, ".lando.yml"), "name: demo\n");
  await writeFile(join(root, ".lando.base.yml"), "lando: not-a-range\n");
  await writeFile(join(root, ".lando.local.yml"), 'lando: "*"\n');

  const snapshot = await lint();

  expect(snapshot.resolved).toBeUndefined();
  expect(snapshot.diagnostic?.unavailable).toEqual([]);
  expect(snapshot.diagnostic?.landofile.document.lando).toBe("*");
});

test.each([
  ["missing include", "includes: [./missing.yml]\n"],
  ["failed include condition", 'includes:\n  - file: ./missing.yml\n    when: "{{ env.UNSET }}"\n'],
  ["missing tooling fragment", "toolingIncludes:\n  tools:\n    file: ./missing.yml\n"],
  ["strict decode refusal", 'networks:\n  shared:\n    name: shared\n    external: "{{ env.UNSET }}"\n'],
])("withholds the diagnostic document for a %s", async (_case, suffix) => {
  await writeFile(join(root, ".lando.yml"), `name: demo\n${suffix}`);

  const snapshot = await lint();

  expect(snapshot.result.valid).toBe(false);
  expect(snapshot.diagnostic).toBeUndefined();
});
