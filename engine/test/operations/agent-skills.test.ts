import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect, type Scope } from "effect";

import { makeTestManagedFileStore } from "@lando/managed-file/testing";

import {
  AGENT_SKILLS_SKILL_BODY,
  AGENT_SKILLS_SKILL_ID,
  AGENT_SKILLS_SKILL_PATH,
  agentSkillManagedFiles,
  installAgentSkills,
  removeAgentSkills,
  updateAgentSkills,
} from "../../src/operations/agent-skills.ts";

const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect);
const runScoped = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(effect));

const withApp = async <T>(runApp: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-agent-skills-")));
  const previousCwd = process.cwd();
  const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
  process.env.LANDO_USER_DATA_ROOT = join(dir, "lando-data");
  try {
    await writeFile(join(dir, ".lando.yml"), "name: agent-skills-app\nservices: {}\n", "utf8");
    return await runApp(dir);
  } finally {
    process.chdir(previousCwd);
    if (previousDataRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
    else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
    await rm(dir, { recursive: true, force: true });
  }
};

describe("agent skill pack ownership", () => {
  test("install creates the managed skill file and update refreshes owned content", async () => {
    await withApp(async (dir) => {
      const store = await run(makeTestManagedFileStore({ base: dir }));

      const installed = await runScoped(
        installAgentSkills({ appRoot: dir }).pipe(Effect.provide(store.layer)),
      );
      expect(installed.verb).toBe("install");
      expect(installed.entries).toEqual([
        { id: AGENT_SKILLS_SKILL_ID, path: AGENT_SKILLS_SKILL_PATH, action: "create" },
      ]);
      const skill = store.read(AGENT_SKILLS_SKILL_PATH) ?? "";
      expect(skill).toContain(`lando-generated:${AGENT_SKILLS_SKILL_ID}`);
      expect(skill).toContain(AGENT_SKILLS_SKILL_BODY.trim());
      expect(AGENT_SKILLS_SKILL_BODY).not.toContain("docs/guides/");
      expect(AGENT_SKILLS_SKILL_BODY).toContain("Drive Lando through MCP");

      const unchanged = await runScoped(
        updateAgentSkills({ appRoot: dir }).pipe(Effect.provide(store.layer)),
      );
      expect(unchanged.entries[0]?.action).toBe("skip-unchanged");

      const current = agentSkillManagedFiles()[0];
      if (current === undefined) {
        throw new Error("agent skill pack must declare the managed skill file");
      }
      await runScoped(
        store.service.apply([
          {
            ...current,
            content: { kind: "text" as const, value: "prior pack body\n" },
          },
        ]),
      );
      expect(store.read(AGENT_SKILLS_SKILL_PATH)).toContain("prior pack body");

      const refreshed = await runScoped(
        updateAgentSkills({ appRoot: dir }).pipe(Effect.provide(store.layer)),
      );
      expect(refreshed.entries[0]?.action).toBe("update");
      expect(store.read(AGENT_SKILLS_SKILL_PATH)).toContain("Run tooling in Lando");
      expect(store.read(AGENT_SKILLS_SKILL_PATH)).not.toContain("prior pack body");
    });
  });

  test("install skips a pre-existing unmarked skill file and remove leaves it alone", async () => {
    await withApp(async (dir) => {
      const store = await run(makeTestManagedFileStore({ base: dir }));
      store.seed(AGENT_SKILLS_SKILL_PATH, "my handwritten skill\n");
      store.seed("NOTES.md", "user notes\n");

      const installed = await runScoped(
        installAgentSkills({ appRoot: dir }).pipe(Effect.provide(store.layer)),
      );
      expect(installed.entries[0]?.action).toBe("skip-adopted");
      expect(store.read(AGENT_SKILLS_SKILL_PATH)).toBe("my handwritten skill\n");

      const removed = await runScoped(removeAgentSkills({ appRoot: dir }).pipe(Effect.provide(store.layer)));
      expect(removed.entries).toEqual([]);
      expect(store.read(AGENT_SKILLS_SKILL_PATH)).toBe("my handwritten skill\n");
      expect(store.read("NOTES.md")).toBe("user notes\n");
    });
  });

  test("remove deletes owned skill files only", async () => {
    await withApp(async (dir) => {
      const store = await run(makeTestManagedFileStore({ base: dir }));
      store.seed("NOTES.md", "user notes\n");

      await runScoped(installAgentSkills({ appRoot: dir }).pipe(Effect.provide(store.layer)));
      expect(store.read(AGENT_SKILLS_SKILL_PATH)).toContain("lando-generated:");

      const removed = await runScoped(removeAgentSkills({ appRoot: dir }).pipe(Effect.provide(store.layer)));
      expect(removed.entries).toEqual([
        { id: AGENT_SKILLS_SKILL_ID, path: AGENT_SKILLS_SKILL_PATH, action: "update" },
      ]);
      expect(store.read(AGENT_SKILLS_SKILL_PATH)).toBeNull();
      expect(store.read("NOTES.md")).toBe("user notes\n");
    });
  });

  test("fails without a Landofile", async () => {
    const empty = await realpath(await mkdtemp(join(tmpdir(), "lando-agent-skills-empty-")));
    const previousCwd = process.cwd();
    try {
      const store = await run(makeTestManagedFileStore({ base: empty }));
      const exit = await Effect.runPromiseExit(
        installAgentSkills({ cwd: empty }).pipe(Effect.provide(store.layer), Effect.scoped),
      );
      expect(exit._tag).toBe("Failure");
    } finally {
      process.chdir(previousCwd);
      await rm(empty, { recursive: true, force: true });
    }
  });
});
