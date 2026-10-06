import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { AbsolutePath } from "@lando/sdk/schema";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { makeTestStateStore } from "@lando/state-store/testing";
import { Effect } from "effect";
import { makeDataMoverService } from "../src/service.ts";

let base: string;
let appRoot: string;
let scratchRoot: string;
let cwdSpy: { mockRestore(): void };
beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "lando-data-containment-")));
  appRoot = join(base, "app");
  scratchRoot = join(base, "scratch");
  await fs.mkdir(appRoot);
  await fs.writeFile(join(appRoot, ".lando.yml"), "name: containment-app\n");
  // Containment prefers the cwd's app; run outside any app so only the fixture Landofile counts.
  cwdSpy = spyOn(process, "cwd").mockReturnValue(base);
});
afterEach(async () => {
  cwdSpy.mockRestore();
  await fs.rm(base, { recursive: true, force: true });
});

const transfer = (source: string, target: string) => {
  const mover = makeDataMoverService(
    TestRuntimeProvider,
    { redactText: (text) => text, publish: () => Effect.void },
    { paths: { ...makeLandoPaths(), scratchDir: scratchRoot }, stateStore: makeTestStateStore().service },
  );
  return Effect.runPromise(
    Effect.scoped(
      Effect.result(
        mover.transfer({
          from: { _tag: "hostPath", path: AbsolutePath.make(source) },
          to: { _tag: "hostPath", path: AbsolutePath.make(target) },
          overwrite: true,
        }),
      ),
    ),
  );
};

test("copies from ..local into missing scratch suffixes", async () => {
  // Given an app directory whose first segment begins with two dots
  const source = join(appRoot, "..local");
  const target = join(scratchRoot, "..local", "missing", "root");
  await fs.mkdir(source);
  await fs.writeFile(join(source, "file"), "payload");
  // When the real data-mover performs the transfer
  const result = await transfer(source, target);
  // Then lexical containment accepts the segment and scratch ancestors allow creation
  expect(result._tag).toBe("Success");
  expect(await fs.readFile(join(target, "file"), "utf8")).toBe("payload");
});

test("climbs past injected source EACCES rather than reconstructing the target", async () => {
  // Given a denied realpath for an existing app source
  const source = join(appRoot, "source");
  const target = join(scratchRoot, "missing", "root");
  await fs.mkdir(source);
  await fs.writeFile(join(source, "file"), "payload");
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  const lookup = spyOn(fs, "realpath").mockResolvedValueOnce(appRoot).mockRejectedValueOnce(denied);
  try {
    // When data-mover validates and copies the source
    const result = await transfer(source, target);
    // Then its catch-all ancestor policy still permits the in-root source
    expect(result._tag).toBe("Success");
    expect(lookup.mock.calls.slice(0, 3).map(([path]) => path)).toEqual([appRoot, source, appRoot]);
    expect(await fs.readFile(join(target, "file"), "utf8")).toBe("payload");
  } finally {
    lookup.mockRestore();
  }
});

test("fails in the data-mover domain when no source ancestor resolves", async () => {
  // Given a root lookup that succeeds but every source-ancestor lookup fails
  const source = join(appRoot, "source");
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  const lookup = spyOn(fs, "realpath").mockRejectedValue(denied).mockResolvedValueOnce(appRoot);
  try {
    // When data-mover exhausts the source's ancestors
    const result = await transfer(source, join(scratchRoot, "root"));
    // Then no original-path fallback is introduced
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toMatchObject({
        _tag: "DataSourceOutsideRootError",
        path: source,
        base: appRoot,
      });
    }
  } finally {
    lookup.mockRestore();
  }
});

test("rejects a scratch sibling prefix", async () => {
  // Given an app source and a destination adjacent to the configured scratch directory
  const source = join(appRoot, "source");
  await fs.mkdir(source);
  // When a sibling-prefix destination is requested
  const result = await transfer(source, join(`${scratchRoot}-sibling`, "root"));
  // Then neither app nor scratch lexical containment accepts it
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") expect(result.failure._tag).toBe("DataSourceOutsideRootError");
});

test("checks only the resolved scratch ancestor when the configured root is missing", async () => {
  // Given a source tree and a missing configured scratch root beneath an existing parent
  const source = join(appRoot, "source");
  await fs.mkdir(source);
  await fs.writeFile(join(source, "file"), "payload");
  // When a target at scratch-root equality is copied
  const result = await transfer(source, scratchRoot);
  // Then the scratch policy's allowed ancestor relation creates the configured root
  expect(result._tag).toBe("Success");
  expect(await fs.readFile(join(scratchRoot, "file"), "utf8")).toBe("payload");
});
