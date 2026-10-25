import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { lintLandofileSnapshot } from "../src/lint.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "./support.ts";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lint-router-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const write = (file: string, body: string) => writeFile(join(root, file), body);
const lint = () =>
  Effect.runPromise(
    lintLandofileSnapshot(
      { cwd: root },
      {
        ports: makeTestLandofilePorts(root),
        stateStore: makeTestLandofileStateStore(),
        templates: { modules: [] },
      },
    ),
  );

test("warns that a Landofile router.bindAddress is global-only", async () => {
  // Given a Landofile that sets the shared-router bind.
  await write(".lando.yml", "name: warning\nrouter:\n  bindAddress: 0.0.0.0\n");
  // When
  const { result, resolved } = await lint();
  // Then lint stays valid and names the global-only rule.
  expect(result.valid).toBe(true);
  expect(result.violations).toEqual([
    expect.objectContaining({
      rule: "router.bind-address-global-only",
      severity: "warning",
      scopes: ["effective"],
      path: ["router", "bindAddress"],
      source: {
        file: join(root, ".lando.yml"),
        layer: "canonical",
        path: ["router", "bindAddress"],
      },
      line: 3,
      column: 3,
    }),
  ]);
  expect(resolved?.document.router?.bindAddress).toBe("0.0.0.0");
});

test("does not warn when the Landofile omits router.bindAddress", async () => {
  // Given a Landofile that only pins router ports.
  await write(".lando.yml", "name: warning\nrouter:\n  httpPort: 8080\n");
  // When
  const { result } = await lint();
  // Then no bind-address warning is emitted.
  expect(result.valid).toBe(true);
  expect(result.violations.filter((issue) => issue.rule === "router.bind-address-global-only")).toEqual([]);
});
