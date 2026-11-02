import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { updateAuthoredIncludes, verifyAuthoredIncludes } from "./include-pipeline.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "./support.ts";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-verify-conditions-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const request = { source: "github:acme/shared", path: "fragment.yml" };
const options = () => ({
  appRoot: root,
  cacheRoot: join(root, "cache"),
  ports: makeTestLandofilePorts(join(root, "cache")),
  stateStore: makeTestLandofileStateStore(),
});

test.each([
  { when: false, disabled: true },
  { when: true, disabled: false },
  { when: "{{ false }}", disabled: true },
  { when: "{{ env.LANDO_VERIFY_UNSET_1646 }}", disabled: false },
  { when: "{{ 1 }}", disabled: false },
  { when: "not an expression", disabled: false },
  { when: "{{ app.name == 'x' }}", disabled: false },
])("missing pin annotation for $when is advisory", async ({ when, disabled }) => {
  const report = await Effect.runPromise(
    verifyAuthoredIncludes({
      ...options(),
      landofile: { includes: [{ ...request, when }] },
    }),
  );
  expect(report.entries).toEqual([
    {
      source: "github:acme/shared/fragment.yml",
      status: "missing",
      expected: null,
      actual: "<default>",
      ...(disabled ? { condition: "disabled" } : {}),
    },
  ]);
  expect(report.ok).toBe(false);
  expect(report.failures).toEqual([]);
  expect(report.mismatches).toHaveLength(1);
  if (disabled) {
    expect(report.mismatches[0]?.remediation).toContain("disabled here");
    expect(report.mismatches[0]?.remediation).toContain("lando app:includes:update");
    expect(report.mismatches[0]?.remediation).toContain("every environment resolves the same revision");
  }
  expect(await Bun.file(join(root, ".lando.lock.yml")).exists()).toBe(false);
});

test("a source is not disabled when any reachable occurrence is enabled", async () => {
  const report = await Effect.runPromise(
    verifyAuthoredIncludes({
      ...options(),
      landofile: {
        includes: [
          { ...request, when: false },
          { ...request, when: true },
        ],
      },
    }),
  );
  expect(report.entries).toEqual([
    {
      source: "github:acme/shared/fragment.yml",
      status: "missing",
      expected: null,
      actual: "<default>",
    },
  ]);
  expect(report.failures).toEqual([]);
});

test("annotation does not suppress acquisition failures inside disabled entries", async () => {
  const report = await Effect.runPromise(
    verifyAuthoredIncludes({
      ...options(),
      landofile: {
        includes: [
          { ...request, when: false },
          { source: "./missing-local.yml", when: false },
        ],
      },
    }),
  );
  expect(report.entries).toMatchObject([{ status: "missing", condition: "disabled" }]);
  expect(report.failures).toMatchObject([{ _tag: "LandofileIncludeError", path: ["includes", 1] }]);
  expect(report.ok).toBe(false);
});

test("disabled entries still report content mismatches and leave pins untouched", async () => {
  const content = "services:\n  remote:\n    image: redis:7\n";
  const cache = join(root, "cache", "includes", "git", "a".repeat(40));
  await mkdir(cache, { recursive: true });
  await writeFile(join(cache, "fragment.yml"), content);
  const lock = `includes:\n  - source: github:acme/shared/fragment.yml\n    resolved: ${"a".repeat(40)}\n    checksum: ${"b".repeat(64)}\n`;
  await writeFile(join(root, ".lando.lock.yml"), lock);
  const report = await Effect.runPromise(
    verifyAuthoredIncludes({
      ...options(),
      landofile: { includes: [{ ...request, when: false }] },
    }),
  );
  expect(report.entries).toMatchObject([{ status: "mismatch", condition: "disabled" }]);
  expect(report.mismatches).toMatchObject([{ _tag: "LandofileLockMismatchError" }]);
  expect(report.ok).toBe(false);
  expect(await Bun.file(join(root, ".lando.lock.yml")).text()).toBe(lock);
});

test.each([false, true])(
  "disabled parent with separately enabled descendant=%s preserves offline verification",
  async (enabled) => {
    const input = options();
    await Effect.runPromise(
      updateAuthoredIncludes({
        ...input,
        landofile: { includes: [{ ...request, when: false }] },
        deps: {
          gitCloner: {
            clone: async ({ stagingDir }) => {
              await mkdir(stagingDir, { recursive: true });
              await writeFile(join(stagingDir, "fragment.yml"), "includes:\n  - ./nested.yml\n");
              await writeFile(join(stagingDir, "nested.yml"), "services:\n  nested:\n    image: redis:7\n");
              return { commitSha: "a".repeat(40) };
            },
          },
        },
      }),
    );
    const before = await Bun.file(join(root, ".lando.lock.yml")).text();
    const report = await Effect.runPromise(
      verifyAuthoredIncludes({
        ...input,
        landofile: {
          includes: [
            { ...request, when: false },
            ...(enabled ? [{ ...request, path: "nested.yml", version: "a".repeat(40), when: true }] : []),
          ],
        },
        deps: {
          gitCloner: {
            clone: async () => {
              throw new Error("Offline verification must use cached pins");
            },
          },
        },
      }),
    );
    expect(report.entries.map(({ source, status, condition }) => ({ source, status, condition }))).toEqual([
      { source: "github:acme/shared/fragment.yml", status: "ok", condition: "disabled" },
      { source: "github:acme/shared/nested.yml", status: "ok", condition: enabled ? undefined : "disabled" },
    ]);
    expect(report.ok).toBe(true);
    expect(report.failures).toEqual([]);
    expect(await Bun.file(join(root, ".lando.lock.yml")).text()).toBe(before);
  },
);
