import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { LandoEvent } from "@lando/sdk/services";

import { initAppWithOwnerOnlyFileAccess as initApp } from "../_support/private-file-access.ts";

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
  test("closes the tree as failed when opt-in agent skill installation fails", async () => {
    await withTempCwd(async (dir) => {
      // Given a real managed-file parent collision in an otherwise valid destination.
      await mkdir(join(dir, "skills-fail"));
      await Bun.write(join(dir, "skills-fail", ".agents"), "user-owned file\n");
      const sink = collector();

      // When recipe rendering succeeds but opt-in installation cannot write its files.
      await expect(
        initApp({
          cwd: dir,
          recipe: "toolbox",
          name: "skills-fail",
          full: false,
          nonInteractive: true,
          runPostInit: false,
          agentSkills: true,
          events: { publish: sink.publish },
        }),
      ).rejects.toMatchObject({
        _tag: "ManagedFileError",
        reason: "io",
        cause: { code: "ENOTDIR" },
      });

      // Then the final tree reports failure, never premature initialization success.
      expect(sink.events.filter((event) => event._tag === "task.tree.complete")).toMatchObject([
        { failed: 1, succeeded: 1 },
      ]);
      expect(sink.events.at(-1)).toMatchObject({ _tag: "task.tree.complete", failed: 1 });
      expect(sink.events).toContainEqual(
        expect.objectContaining({ _tag: "task.fail", taskId: "agentskills" }),
      );
    });
  });

  test("completes opt-in agent skills before closing the successful tree", async () => {
    await withTempCwd(async (dir) => {
      // Given an empty destination and opt-in installation.
      const sink = collector();
      // When initialization runs to completion.
      const result = await initApp({
        cwd: dir,
        recipe: "toolbox",
        name: "skills-on",
        full: false,
        nonInteractive: true,
        runPostInit: false,
        agentSkills: true,
        events: { publish: sink.publish },
      });
      // Then installation completes inside the successful tree.
      expect(result.agentSkills?.entries).toMatchObject([{ action: "create" }]);
      expect(sink.events.at(-2)).toMatchObject({ _tag: "task.complete", taskId: "agentskills" });
      expect(sink.events.at(-1)).toMatchObject({
        _tag: "task.tree.complete",
        failed: 0,
        succeeded: 2,
      });
    });
  });

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
      if (renderComplete?._tag === "task.complete") {
        expect(renderComplete.summary).toBe("Rendered 3 files");
      }

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
        if (postinitComplete?._tag === "task.complete") {
          expect(postinitComplete.summary).toBe("Ran 1 action");
        }
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

  test("uses singular file and action counts for a one-file recipe", async () => {
    await withTempCwd(async (dir) => {
      const sink = collector();
      await initApp({
        cwd: dir,
        recipe: "toolbox",
        full: false,
        name: "toolbox-app",
        nonInteractive: true,
        events: { publish: sink.publish },
        postInitIO: bufferedPostInitIO().io,
      });
      const summaries = sink.events
        .filter((event) => event._tag === "task.complete")
        .map((event) => event.summary);
      expect(summaries).toContain("Rendered 1 file");
      expect(summaries).toContain("Ran 1 action");
    });
  });

  test("publishes task.fail on the render task when the Landofile dest already exists", async () => {
    await withTempCwd(async (dir) => {
      await mkdir(join(dir, "occupied"), { recursive: true });
      await Bun.write(join(dir, "occupied", ".lando.yml"), "name: occupied\n");

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
});
