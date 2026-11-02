import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitLandofileYaml } from "@lando/sdk/landofile";
import { Effect } from "effect";
import { loadLandofileLayers } from "../src/service.ts";
import { updateAuthoredIncludes, verifyAuthoredIncludes } from "./include-pipeline.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "./support.ts";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-conditional-locks-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const request = { source: "github:acme/shared", path: "fragment.yml", when: false };
const fixture = () => {
  const ports = makeTestLandofilePorts(join(root, "cache"));
  return {
    appRoot: root,
    cacheRoot: join(root, "cache"),
    stateStore: makeTestLandofileStateStore(),
    templates: { modules: [] },
    ports: {
      ...ports,
      git: {
        clone: async ({ dest }: { readonly dest: string }) => {
          await mkdir(dest, { recursive: true });
          await writeFile(
            join(dest, "fragment.yml"),
            'includes:\n  - source: ./nested.yml\n    when: "{{ env.IGNORED_CONDITION }}"\nservices:\n  remote:\n    image: alpine:3\n',
          );
          await writeFile(join(dest, "nested.yml"), "services:\n  nested:\n    image: redis:7\n");
          return { commitSha: "a".repeat(40) };
        },
      },
    },
  };
};

test("update pins disabled parents and their conditional descendants (#1569 QA26)", async () => {
  const report = await Effect.runPromise(
    updateAuthoredIncludes({ ...fixture(), landofile: { includes: [request] } }),
  );
  expect(report.wrote).toBe(true);
  expect(report.entries.map((entry) => entry.source)).toEqual([
    "github:acme/shared/fragment.yml",
    "github:acme/shared/nested.yml",
  ]);
});

test("verify walks disabled parents and descendants from their existing pins (#1569 QA26)", async () => {
  const input = fixture();
  await Effect.runPromise(updateAuthoredIncludes({ ...input, landofile: { includes: [request] } }));
  const report = await Effect.runPromise(
    verifyAuthoredIncludes({
      ...input,
      ports: makeTestLandofilePorts(input.cacheRoot),
      landofile: { includes: [request] },
    }),
  );
  expect(report.ok).toBe(true);
  expect(report.entries.map((entry) => entry.source)).toEqual([
    "github:acme/shared/fragment.yml",
    "github:acme/shared/nested.yml",
  ]);
  expect(report.failures).toEqual([]);
});

test("ordinary loads leave pins for disabled entries untouched", async () => {
  const input = fixture();
  await Effect.runPromise(updateAuthoredIncludes({ ...input, landofile: { includes: [request] } }));
  const before = await Bun.file(join(root, ".lando.lock.yml")).text();
  await writeFile(join(root, ".lando.yml"), emitLandofileYaml({ name: "conditional", includes: [request] }));
  const compiled = await Effect.runPromise(
    loadLandofileLayers(root, join(root, ".lando.yml"), {
      ports: makeTestLandofilePorts(input.cacheRoot),
      stateStore: input.stateStore,
      templates: input.templates,
    }),
  );
  expect(Object.keys(compiled.document.services ?? {})).toEqual([]);
  expect(await Bun.file(join(root, ".lando.lock.yml")).text()).toBe(before);
});

test("conditions do not permit two versions of one remote fragment", async () => {
  const input = fixture();
  await writeFile(
    join(root, ".lando.yml"),
    emitLandofileYaml({
      name: "conditional",
      includes: [
        { ...request, version: "v1" },
        { ...request, version: "v2" },
      ],
    }),
  );
  const error = await Effect.runPromise(
    Effect.flip(loadLandofileLayers(root, join(root, ".lando.yml"), input)),
  );
  expect(error).toMatchObject({
    _tag: "LandofileIncludeError",
    kind: "source-unresolved",
    path: ["includes", 1],
  });
  expect(await Bun.file(join(root, ".lando.lock.yml")).exists()).toBe(false);
});
