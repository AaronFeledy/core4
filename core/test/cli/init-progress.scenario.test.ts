import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { LandoEvent } from "@lando/sdk/services";

import { initApp } from "../../src/cli/commands/init.ts";

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-init-progress-")));
  const previousCwd = process.cwd();
  const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
  process.env.LANDO_USER_DATA_ROOT = join(dir, "lando-data");
  try {
    return await run(dir);
  } finally {
    process.chdir(previousCwd);
    if (previousDataRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
    else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
    await rm(dir, { recursive: true, force: true });
  }
};

const collector = () => {
  const events: LandoEvent[] = [];
  const publish = (event: LandoEvent) =>
    Effect.sync(() => {
      events.push(event);
    });
  return { events, publish };
};

const bufferedPostInitIO = () => {
  const lines: string[] = [];
  return {
    io: {
      out: (line: string) => {
        lines.push(line);
      },
      err: (line: string) => {
        lines.push(line);
      },
    },
    lines,
  };
};

describe("lando init: task tree progress", () => {
  test("publishes tree.start → render → postinit → tree.complete around the recipe", async () => {
    await withTempCwd(async (dir) => {
      const sink = collector();
      const postInitBuffer = bufferedPostInitIO();
      const result = await initApp({
        cwd: dir,
        full: true,
        name: "mvp",
        nonInteractive: true,
        events: { publish: sink.publish },
        postInitIO: postInitBuffer.io,
      });

      expect(result.appName).toBe("mvp");
      const tags = sink.events.map((event) => event._tag);
      expect(tags[0]).toBe("task.tree.start");
      expect(tags[tags.length - 1]).toBe("task.tree.complete");

      const treeStart = sink.events[0];
      expect(treeStart?._tag).toBe("task.tree.start");
      if (treeStart?._tag === "task.tree.start") {
        expect(treeStart.children).toContain("render");
      }

      const renderStart = sink.events.find(
        (event) => event._tag === "task.start" && event.taskId === "render",
      );
      const renderComplete = sink.events.find(
        (event) => event._tag === "task.complete" && event.taskId === "render",
      );
      expect(renderStart).toBeDefined();
      expect(renderComplete).toBeDefined();

      const hasPostInit = result.postInit.executed.length > 0;
      if (hasPostInit) {
        const postinitStart = sink.events.find(
          (event) => event._tag === "task.start" && event.taskId === "postinit",
        );
        const postinitComplete = sink.events.find(
          (event) => event._tag === "task.complete" && event.taskId === "postinit",
        );
        expect(postinitStart).toBeDefined();
        expect(postinitComplete).toBeDefined();
        if (treeStart?._tag === "task.tree.start") {
          expect(treeStart.children).toContain("postinit");
        }
        const renderCompleteIdx = sink.events.findIndex(
          (event) => event._tag === "task.complete" && event.taskId === "render",
        );
        const postinitStartIdx = sink.events.findIndex(
          (event) => event._tag === "task.start" && event.taskId === "postinit",
        );
        expect(postinitStartIdx).toBeGreaterThan(renderCompleteIdx);
      }

      const treeComplete = sink.events[sink.events.length - 1];
      if (treeComplete?._tag === "task.tree.complete") {
        expect(treeComplete.failed).toBe(0);
        expect(treeComplete.succeeded).toBeGreaterThanOrEqual(1);
      }
    });
  });

  test("publishes task.fail on the render task when the target directory already exists", async () => {
    await withTempCwd(async (dir) => {
      await Bun.write(join(dir, "occupied", "keep.txt"), "do not overwrite");

      const sink = collector();
      let caught: unknown;
      try {
        await initApp({
          cwd: dir,
          full: true,
          name: "occupied",
          nonInteractive: true,
          events: { publish: sink.publish },
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();

      const tags = sink.events.map((event) => event._tag);
      expect(tags[0]).toBe("task.tree.start");
      expect(tags).toContain("task.start");
      expect(tags).toContain("task.fail");
      expect(tags[tags.length - 1]).toBe("task.tree.complete");

      const renderStartIdx = sink.events.findIndex(
        (event) => event._tag === "task.start" && event.taskId === "render",
      );
      const renderFailIdx = sink.events.findIndex(
        (event) => event._tag === "task.fail" && event.taskId === "render",
      );
      expect(renderStartIdx).toBeGreaterThan(0);
      expect(renderFailIdx).toBeGreaterThan(renderStartIdx);

      const treeComplete = sink.events[sink.events.length - 1];
      if (treeComplete?._tag === "task.tree.complete") {
        expect(treeComplete.failed).toBe(1);
        expect(treeComplete.succeeded).toBe(0);
      }
    });
  });

  test("publishes task.fail and task.tree.complete when readdir throws unexpectedly", async () => {
    await withTempCwd(async (dir) => {
      const blocked = join(dir, "blocked");
      await mkdir(blocked, { recursive: true });
      await chmod(blocked, 0);

      const sink = collector();
      let caught: unknown;
      try {
        await initApp({
          cwd: dir,
          full: true,
          name: "blocked",
          nonInteractive: true,
          events: { publish: sink.publish },
        });
      } catch (err) {
        caught = err;
      } finally {
        await chmod(blocked, 0o755);
      }

      expect(caught).toBeDefined();
      const tags = sink.events.map((event) => event._tag);
      expect(tags[0]).toBe("task.tree.start");
      expect(tags).toContain("task.fail");
      expect(tags[tags.length - 1]).toBe("task.tree.complete");
      const renderFail = sink.events.find((event) => event._tag === "task.fail" && event.taskId === "render");
      expect(renderFail).toBeDefined();
    });
  });
});
