import type { AgentSkillsError, AgentSkillsResult } from "../../../../commands/agent-skills";
import {
  AgentSkillsResultSchema,
  removeAgentSkills,
  renderAgentSkillsResult,
} from "../../../../commands/agent-skills";
import type { LandoCommandSpec } from "../../../../spec/command-base";

export const appAgentSkillsRemoveSpec: LandoCommandSpec<AgentSkillsResult, AgentSkillsError> = {
  resultSchema: AgentSkillsResultSchema,
  id: "app:agent:skills:remove",
  summary: "Delete Lando-owned agent skill files in this app. Adopted or user files stay.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "minimal",
  run: () => removeAgentSkills(),
  render: (result) => renderAgentSkillsResult(result as AgentSkillsResult),
};
