import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbsolutePath, AppId } from "@lando/sdk/schema";
import { Effect } from "effect";
import { withResolvedCwd } from "../../src/landofile/app-resolution.ts";
import { destroyApp, destroyAppAtRoot } from "../../src/operations/destroy.ts";
import { stopApp, stopAppWithPlan } from "../../src/operations/stop.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";
import { current, fixture, stale, target } from "./legacy-teardown-support.ts";

test.each(["stop", "destroy"] as const)(
  "%s leaves colocated scratch realizations untouched during legacy reconciliation",
  async (command) => {
    const harness = fixture();
    const scratch = {
      ...current,
      id: AppId.make("scratch-legacy"),
      extensions: { "@lando/core/scratch": { id: "scratch-legacy" } },
    };
    harness.applied.push(scratch);
    harness.containers.add(scratch.id);
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          if (command === "stop") yield* stopApp({}, target);
          else yield* destroyApp({}, target);
        }).pipe(Effect.provide(harness.layer)),
      );
      expect(harness.applied.map((plan) => plan.id)).toEqual(
        command === "stop" ? [current.id, scratch.id] : [scratch.id],
      );
      expect([...harness.containers]).toEqual([scratch.id]);
    } finally {
      rmSync(harness.userDataRoot, { recursive: true, force: true });
    }
  },
);

test.each([false, true])(
  "stop retires the stale name and stops the current realization while keeping data (with plan: %s)",
  async (withPlan) => {
    const harness = fixture();
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          return withPlan ? (yield* stopAppWithPlan({}, target)).result : yield* stopApp({}, target);
        }).pipe(Effect.provide(harness.layer)),
      );
      expect(result.app).toBe(current.name);
      expect(result.outcome).toBe("stopped");
      expect([...harness.containers]).toEqual([]);
      expect(harness.applied.map((plan) => plan.id)).toEqual([current.id]);
      expect([...harness.volumes]).toEqual([stale.id, current.id]);
    } finally {
      rmSync(harness.userDataRoot, { recursive: true, force: true });
    }
  },
);

test.each(["stop", "destroy"] as const)(
  "%s handles legacy state when neither name matches the requested app",
  async (command) => {
    const harness = fixture();
    const desired = { ...current, id: AppId.make("third-name"), name: "third-name", slug: "third-name" };
    const requested = { ...target, plan: desired, app: { ...target.app, id: desired.id } };
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          switch (command) {
            case "stop":
              return yield* stopApp({}, requested);
            case "destroy":
              return yield* destroyApp({}, requested);
          }
        }).pipe(Effect.provide(harness.layer), Effect.result),
      );
      expect(result).toMatchObject({
        _tag: "Success",
        success: { outcome: command === "stop" ? "stopped" : "destroyed" },
      });
      expect(harness.applied).toEqual([]);
      expect([...harness.containers]).toEqual([]);
    } finally {
      rmSync(harness.userDataRoot, { recursive: true, force: true });
    }
  },
);

test.each(
  [false, true].flatMap((landofile) => [
    { volumes: false, purgeCaches: false, landofile },
    { volumes: true, purgeCaches: false, landofile },
    { volumes: false, purgeCaches: true, landofile },
    { volumes: true, purgeCaches: true, landofile },
  ]),
)(
  "destroy removes both legacy realizations (volumes: $volumes, caches: $purgeCaches, Landofile: $landofile)",
  async ({ volumes, purgeCaches, landofile }) => {
    const harness = fixture();
    try {
      const result = await Effect.runPromise(
        destroyApp(
          { volumes, purgeCaches },
          landofile
            ? {
                ...target,
                landofile: literalTestLandofile({ name: current.name, services: {} }),
              }
            : target,
        ).pipe(Effect.provide(harness.layer)),
      );
      expect(result.outcome).toBe("destroyed");
      expect(harness.applied).toEqual([]);
      expect([...harness.containers]).toEqual([]);
      expect([...harness.volumes]).toEqual(volumes ? [] : [stale.id, current.id]);
      expect([...harness.caches]).toEqual(purgeCaches ? [] : [stale.id, current.id]);
    } finally {
      rmSync(harness.userDataRoot, { recursive: true, force: true });
    }
  },
);

test("destroy --root removes every realization of a missing folder", async () => {
  const root = AbsolutePath.make(`${current.root}/missing`);
  const harness = fixture(root);
  try {
    const result = await Effect.runPromise(
      destroyAppAtRoot(root, { volumes: true }).pipe(
        Effect.provide(BunFileSystem.layer),
        Effect.provide(harness.layer),
      ),
    );
    expect(result.outcome).toBe("destroyed");
    expect(harness.applied).toEqual([]);
    expect([...harness.volumes]).toEqual([]);
  } finally {
    rmSync(harness.userDataRoot, { recursive: true, force: true });
  }
});

test.each(["stop", "destroy"] as const)(
  "cwd %s reconciles or observes legacy state using the Landofile name",
  async (command) => {
    const root = AbsolutePath.make(mkdtempSync(join(tmpdir(), "lando-legacy-cwd-")));
    const harness = fixture(root);
    await Bun.write(join(root, ".lando.yml"), `name: ${current.name}\nservices: {}\n`);
    const operation = Effect.gen(function* () {
      switch (command) {
        case "stop":
          return yield* stopApp();
        case "destroy":
          return yield* destroyApp();
      }
    });
    try {
      const result = await Effect.runPromise(
        withResolvedCwd(root, operation).pipe(Effect.provide(harness.layer)),
      );
      expect(result.app).toBe(current.name);
      expect(harness.applied.map((plan) => plan.id)).toEqual(command === "stop" ? [current.id] : []);
      expect([...harness.containers]).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(harness.userDataRoot, { recursive: true, force: true });
    }
  },
);
