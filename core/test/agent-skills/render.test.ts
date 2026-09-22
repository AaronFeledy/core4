import { describe, expect, test } from "bun:test";

import { AGENT_SKILLS_SKILL_PATH } from "@lando/engine/operations/agent-skills";
import { renderAgentSkillsResult } from "../../src/cli/commands/agent-skills.ts";

describe("agent skills CLI presentation", () => {
  test("remove reports a delete outcome instead of ManagedFile update", () => {
    const text = renderAgentSkillsResult({
      verb: "remove",
      appRoot: "/app",
      entries: [{ id: "lando:agent-skills:skill", path: AGENT_SKILLS_SKILL_PATH, action: "update" }],
    });
    expect(text).toContain(`- ${AGENT_SKILLS_SKILL_PATH} (remove)`);
    expect(text).not.toContain("~");
    expect(text).not.toContain("(update)");
  });

  test("remove reports preserved conflicts and adopted files truthfully", () => {
    const conflict = renderAgentSkillsResult({
      verb: "remove",
      appRoot: "/app",
      entries: [{ id: "lando:agent-skills:skill", path: AGENT_SKILLS_SKILL_PATH, action: "conflict" }],
    });
    const adopted = renderAgentSkillsResult({
      verb: "remove",
      appRoot: "/app",
      entries: [{ id: "lando:agent-skills:skill", path: AGENT_SKILLS_SKILL_PATH, action: "adopt-detected" }],
    });

    expect(conflict).toContain(`! ${AGENT_SKILLS_SKILL_PATH} (conflict)`);
    expect(adopted).toContain(`! ${AGENT_SKILLS_SKILL_PATH} (adopt-detected)`);
    expect(conflict).not.toContain("Removed agent skills");
    expect(adopted).not.toContain("Removed agent skills");
  });

  test("install and update keep ManagedFile action glyphs", () => {
    expect(
      renderAgentSkillsResult({
        verb: "install",
        appRoot: "/app",
        entries: [{ id: "lando:agent-skills:skill", path: AGENT_SKILLS_SKILL_PATH, action: "create" }],
      }),
    ).toContain(`+ ${AGENT_SKILLS_SKILL_PATH} (create)`);
    expect(
      renderAgentSkillsResult({
        verb: "update",
        appRoot: "/app",
        entries: [{ id: "lando:agent-skills:skill", path: AGENT_SKILLS_SKILL_PATH, action: "update" }],
      }),
    ).toContain(`~ ${AGENT_SKILLS_SKILL_PATH} (update)`);
  });
});
