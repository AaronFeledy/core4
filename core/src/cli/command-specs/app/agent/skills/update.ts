import { Flags } from "../../../../spec/metadata";

import type { AgentSkillsError, AgentSkillsResult } from "../../../../commands/agent-skills";
import {
  AgentSkillsResultSchema,
  renderAgentSkillsResult,
  updateAgentSkills,
} from "../../../../commands/agent-skills";
import type { LandoCommandSpec } from "../../../../spec/command-base";

export const appAgentSkillsUpdateSpec: LandoCommandSpec<AgentSkillsResult, AgentSkillsError> = {
  resultSchema: AgentSkillsResultSchema,
  id: "app:agent:skills:update",
  summary: "Refresh Lando-owned agent skill files in this app.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "minimal",
  flags: {
    format: Flags.string({
      description: "Output format.",
      options: ["text", "json"],
      default: "text",
    }),
  },
  run: () => updateAgentSkills(),
  render: (result) => renderAgentSkillsResult(result as AgentSkillsResult),
};
