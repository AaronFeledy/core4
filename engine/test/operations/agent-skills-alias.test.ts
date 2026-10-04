import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDiskBackend, makeManagedFileServiceFactory } from "@lando/managed-file/service";
import { ManagedFileService } from "@lando/sdk/services";
import { Effect } from "effect";
import {
  AGENT_SKILLS_SKILL_PATH,
  agentSkillManagedFiles,
  resolveAgentSkillsAppRoot,
  updateAgentSkills,
} from "../../src/operations/agent-skills.ts";
import { ownerOnlyFileAccess } from "../private-file-access.ts";

for (const source of ["explicit", "discovered"] as const) {
  test(`updates owned content through the canonical root after ${source} parent-alias installation`, async () => {
    // Given an older owned pack installed under an app-root alias on real disk.
    const root = await realpath(await mkdtemp(join(tmpdir(), "lando-skills-update-alias-")));
    const parent = join(root, "parent");
    const app = join(parent, "app");
    const alias = join(root, "alias");
    await mkdir(app, { recursive: true });
    await symlink(parent, alias, "dir");
    await writeFile(join(app, ".lando.yml"), "name: alias-app\nservices: {}\n");
    try {
      const backend = await Effect.runPromise(
        makeDiskBackend({
          defaultBase: () => root,
          ledgerRoot: () => join(root, "data"),
          privateFileAccess: ownerOnlyFileAccess,
        }),
      );
      const factory = await Effect.runPromise(makeManagedFileServiceFactory(backend));
      const aliasRoot = await Effect.runPromise(
        resolveAgentSkillsAppRoot(
          source === "explicit" ? { appRoot: join(alias, "app") } : { cwd: join(alias, "app") },
        ),
      );
      const aliasService = await Effect.runPromise(factory.forBase(aliasRoot));
      await Effect.runPromise(
        Effect.scoped(
          aliasService.apply(
            agentSkillManagedFiles(aliasRoot).map((file) => ({
              ...file,
              content: { kind: "text" as const, value: "prior owned pack\n" },
            })),
          ),
        ),
      );

      // When update discovers the app from its canonical cwd and binds that ledger.
      const canonicalRoot = await Effect.runPromise(resolveAgentSkillsAppRoot({ cwd: app }));
      const canonicalService = await Effect.runPromise(factory.forBase(canonicalRoot));
      const result = await Effect.runPromise(
        updateAgentSkills({ cwd: app }).pipe(Effect.provideService(ManagedFileService, canonicalService)),
      );

      // Then the old owned body is refreshed, rather than adopted or conflicted.
      expect(result.entries).toMatchObject([{ path: AGENT_SKILLS_SKILL_PATH, action: "update" }]);
      const content = await readFile(join(app, AGENT_SKILLS_SKILL_PATH), "utf8");
      expect(content.startsWith("---\nname: lando\n")).toBe(true);
      expect(content).not.toContain("prior owned pack");
      expect(aliasRoot).toBe(app);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
