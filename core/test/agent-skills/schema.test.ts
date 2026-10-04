import { expect, test } from "bun:test";
import {
  AgentSkillsFileResultSchema,
  AgentSkillsResultSchema,
  AgentSkillsVerbSchema,
} from "@lando/engine/operations/agent-skills";
import { Schema } from "effect";
import * as Cli from "../../src/cli/commands/agent-skills.ts";

test("CLI re-exports the operation's wire schemas without a second contract", () => {
  expect(Cli.AgentSkillsFileResultSchema).toBe(AgentSkillsFileResultSchema);
  expect(Cli.AgentSkillsResultSchema).toBe(AgentSkillsResultSchema);
  expect(Cli.AgentSkillsVerbSchema).toBe(AgentSkillsVerbSchema);
});

test("agent skill result schemas retain the existing wire shape", () => {
  const isResult = Schema.is(Cli.AgentSkillsResultSchema);
  const entries = [
    { id: "lando:agent-skills:skill", path: ".agents/skills/lando/SKILL.md", action: "create" },
  ];
  for (const verb of ["install", "update", "remove"]) {
    expect(isResult({ verb, appRoot: "/app", entries })).toBe(true);
    expect(isResult({ verb, appRoot: "/app", entries: [] })).toBe(true);
  }
  expect(isResult({ verb: "refresh", appRoot: "/app", entries })).toBe(false);
  expect(isResult({ verb: "install", appRoot: "/app", entries: [{ ...entries[0], action: "delete" }] })).toBe(
    false,
  );
  expect(isResult({ verb: "install", entries })).toBe(false);
});
