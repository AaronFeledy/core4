import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect, type Scope } from "effect";

import { ManagedFileService } from "@lando/sdk/services";

import { makeDiskBackend, makeManagedFileService } from "@lando/managed-file/service";
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
import { ownerOnlyFileAccess } from "../private-file-access.ts";

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
      expect(skill.startsWith("---\nname: lando\ndescription:")).toBe(true);
      const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/u)?.[1] ?? "";
      expect(Bun.YAML.parse(frontmatter)).toEqual({
        name: "lando",
        description: "Run this app's tooling and inspect its state through Lando.",
      });
      expect(skill).toContain(`lando-generated:${AGENT_SKILLS_SKILL_ID}`);
      expect(AGENT_SKILLS_SKILL_BODY).not.toContain("docs/guides/");
      expect(AGENT_SKILLS_SKILL_BODY).toContain("Drive Lando through MCP");
      expect(String(agentSkillManagedFiles(dir)[0]?.base)).toBe(dir);

      const unchanged = await runScoped(
        updateAgentSkills({ appRoot: dir }).pipe(Effect.provide(store.layer)),
      );
      expect(unchanged.entries[0]?.action).toBe("skip-unchanged");

      const current = agentSkillManagedFiles(dir)[0];
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

  test("disk-backed legacy ownership updates and removes outside the app cwd", async () => {
    await withApp(async (dir) => {
      const dataRoot = process.env.LANDO_USER_DATA_ROOT;
      if (dataRoot === undefined) throw new Error("test data root must be configured");
      const backend = await run(
        makeDiskBackend({
          defaultBase: () => dir,
          ledgerRoot: () => dataRoot,
          privateFileAccess: ownerOnlyFileAccess,
        }),
      );
      const legacy = await run(makeManagedFileService(backend));
      const declared = agentSkillManagedFiles()[0];
      if (declared === undefined) throw new Error("agent skill pack must declare a managed file");
      const prior = { ...declared, content: { kind: "text" as const, value: "prior skill body\n" } };
      const skillPath = join(dir, AGENT_SKILLS_SKILL_PATH);
      const cwd = process.cwd();
      const againstApp = <A, E>(effect: Effect.Effect<A, E, ManagedFileService>) =>
        effect.pipe(Effect.provideService(ManagedFileService, legacy));

      await runScoped(legacy.apply([prior]));
      const updated = await runScoped(againstApp(updateAgentSkills({ appRoot: dir })));
      expect(updated.entries[0]?.action).toBe("update");
      expect(await readFile(skillPath, "utf8")).toContain("name: lando");

      const removed = await run(againstApp(removeAgentSkills({ appRoot: dir })));
      expect(removed.entries[0]?.action).toBe("update");
      await expect(readFile(skillPath, "utf8")).rejects.toBeDefined();

      await runScoped(legacy.apply([prior]));
      await writeFile(skillPath, "user adopted skill\n");
      const adopted = await run(againstApp(removeAgentSkills({ appRoot: dir })));
      expect(adopted.entries[0]?.action).toBe("adopt-detected");
      expect(await readFile(skillPath, "utf8")).toBe("user adopted skill\n");

      await rm(skillPath);
      await runScoped(legacy.apply([prior]));
      await writeFile(skillPath, `${await readFile(skillPath, "utf8")}user edit\n`);
      const edited = await run(againstApp(removeAgentSkills({ appRoot: dir })));
      expect(edited.entries[0]?.action).toBe("conflict");
      expect(await readFile(skillPath, "utf8")).toContain("user edit");
      expect(process.cwd()).toBe(cwd);
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
