// Project-local Lando agent skill pack. One pack in v1: teach agents to run
// tooling through Lando. Content points at existing agent-native docs; it does
// not copy those guides into the app.

import { AbsolutePath, type ManagedFile, PortablePath } from "@lando/sdk/schema";

export const AGENT_SKILLS_OWNER = "lando:agent-skills";

export const AGENT_SKILLS_SKILL_ID = "lando:agent-skills:skill";

export const AGENT_SKILLS_SKILL_PATH = ".agents/skills/lando/SKILL.md";

export const AGENT_SKILLS_SKILL_BODY = `---
name: lando
description: Run this app's tooling and inspect its state through Lando.
---

# Run tooling in Lando

This app is a Lando app. Do not invent a host package manager or language runtime
as the default way to run project tools.

## Decide where you are

- On the host (no Lando service environment): run tools through Lando.
- Inside a Lando service (\`LANDO_APP_NAME\` is set and you are on the service
  filesystem): you are already in the app environment. Run the tool on PATH.
  \`lando\` still reaches the host when \`LANDO_HOST_PROXY_SHIM\` is set.
- Confirm app state from the host with \`lando app:info --format=json\`. Do not
  scrape prose.

## Preferred commands

1. Landofile tooling: \`lando <tooling>\` (for example \`lando composer\` or
   \`lando npm\` when that tool exists on the app). Discover names with
   \`lando --help\` from the app root or \`lando app:config --format=json\`.
2. One-off in a service: \`lando exec -- <command>\` or
   \`lando exec <service> -- <command>\`.
3. Agent MCP: start \`lando mcp\` as a stdio JSON-RPC child. Audit the catalog
   with \`lando mcp --list --format=json\`.

Prefer a named tooling command over raw \`lando exec\` when the Landofile
already defines the tool.

## Read the existing Lando guides

Do not paste product docs into this app. When you need more than this pack,
look up these Lando guides by name:

- Drive Lando through MCP
- Inspect a running app (in-container context)
- Run commands inside a service
- Script Lando with JSON

\`lando start\` and \`lando rebuild\` do not write or refresh this pack.
Install, update, or remove it with \`lando agent:skills:install\`,
\`lando agent:skills:update\`, and \`lando agent:skills:remove\`.
`;

export const agentSkillManagedFiles = (base?: string): ReadonlyArray<ManagedFile> => [
  {
    id: AGENT_SKILLS_SKILL_ID,
    owner: AGENT_SKILLS_OWNER,
    path: PortablePath.make(AGENT_SKILLS_SKILL_PATH),
    mode: "file",
    format: "text",
    ...(base === undefined ? {} : { base: AbsolutePath.make(base) }),
    content: { kind: "text", value: AGENT_SKILLS_SKILL_BODY },
    onConflict: "skip",
  },
];
