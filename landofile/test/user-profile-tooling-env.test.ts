import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Either } from "effect";
import { resolveLandofileIncludes } from "../src/includes.ts";
import { normalizeToolingTask } from "../src/tooling-normalize.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "./support.ts";

test.each([
  ["    env:\n      LANDO_APP_NAME: spoof\n    cmd: echo task\n", true],
  ["    cmds:\n      - cmd: echo step\n        env:\n          LANDO_APP_NAME: spoof\n", true],
  [
    "    env:\n      VALUE: task\n    cmds:\n      - cmd: echo step\n        env:\n          VALUE: step\n",
    false,
  ],
] as const)(
  "normalizes user profile tooling with reserved identity protection: %s",
  async (body, rejected) => {
    const root = await mkdtemp(join(tmpdir(), "lando-profile-tooling-env-"));
    const includes = join(root, "includes");
    try {
      await mkdir(includes);
      await writeFile(join(includes, "profile.yml"), `tooling:\n  check:\n${body}`);
      const landofile = await Effect.runPromise(
        resolveLandofileIncludes({
          landofile: { name: "profile-tooling", includes: ["user:profile.yml"] },
          appRoot: root,
          ports: makeTestLandofilePorts(join(root, "cache"), includes),
          stateStore: makeTestLandofileStateStore(),
        }),
      );
      const task = landofile.tooling?.check;
      expect(task).toBeDefined();
      if (task === undefined) throw new TypeError("Missing fixture task");
      const normalized = normalizeToolingTask("check", task);
      expect(Either.isLeft(normalized)).toBe(rejected);
      if (Either.isRight(normalized)) {
        expect(normalized.right.env).toEqual({ VALUE: "task" });
        expect(normalized.right.steps[0]?.env).toEqual({ VALUE: "step" });
      } else {
        expect(normalized.left._tag).toBe("ToolingCompileError");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
