import { Flags } from "../../../../spec/metadata";

import type { AgentSkillsError, AgentSkillsResult } from "../../../../commands/agent-skills";
import {
  AgentSkillsResultSchema,
  installAgentSkills,
  renderAgentSkillsResult,
} from "../../../../commands/agent-skills";
import type { LandoCommandSpec } from "../../../../spec/command-base";

export const appAgentSkillsInstallSpec: LandoCommandSpec<AgentSkillsResult, AgentSkillsError> = {
  resultSchema: AgentSkillsResultSchema,
  id: "app:agent:skills:install",
  summary: "Write the Lando agent skill pack into this app (opt-in, never on start or rebuild).",
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
  run: () => installAgentSkills(),
  render: (result) => renderAgentSkillsResult(result as AgentSkillsResult),
};
