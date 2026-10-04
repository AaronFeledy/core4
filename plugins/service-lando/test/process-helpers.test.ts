import { describe, expect, test } from "bun:test";

import { type CommandSpec, PortablePath, type ServiceConfig } from "@lando/sdk/schema";

import { applyAuthoredProcessFields } from "../src/services/_process-helpers.ts";

const processDraft = (normalizedConfig: ServiceConfig) => {
  const draft: {
    command: CommandSpec;
    entrypoint: CommandSpec;
    workingDirectory: PortablePath;
    user: string;
  } = {
    command: ["default-command"],
    entrypoint: ["default-entrypoint"],
    workingDirectory: PortablePath.make("/default"),
    user: "default-user",
  };
  const calls: string[] = [];
  const ctx: Parameters<typeof applyAuthoredProcessFields>[0] = {
    normalizedConfig,
    setCommand(value) {
      draft.command = value;
      calls.push("command");
    },
    setEntrypoint(value) {
      draft.entrypoint = value;
      calls.push("entrypoint");
    },
    setWorkingDirectory(value) {
      draft.workingDirectory = value;
      calls.push("workingDirectory");
    },
    setUser(value) {
      draft.user = value;
      calls.push("user");
    },
  };
  return { ctx, draft, calls };
};

describe("applyAuthoredProcessFields", () => {
  test("replaces defaults when all process fields are authored", () => {
    const authored = {
      command: ["authored-command"],
      entrypoint: ["authored-entrypoint"],
      workingDirectory: PortablePath.make("/authored"),
      user: "authored-user",
    };
    const { ctx, draft } = processDraft(authored);

    applyAuthoredProcessFields(ctx);

    expect(draft).toEqual(authored);
  });

  test("keeps existing defaults when process fields are absent", () => {
    const { ctx, draft, calls } = processDraft({});
    const defaults = { ...draft };

    applyAuthoredProcessFields(ctx);

    expect(draft).toEqual(defaults);
    expect(calls).toEqual([]);
  });

  test.each([{ command: "" }, { command: [] }])(
    "preserves empty authored commands when supplied as $command",
    ({ command }) => {
      const { ctx, draft, calls } = processDraft({
        command,
        entrypoint: command,
        workingDirectory: PortablePath.make(""),
        user: "",
      });

      applyAuthoredProcessFields(ctx);

      expect(draft.command).toEqual(command);
      expect(draft.entrypoint).toEqual(command);
      expect(draft.workingDirectory).toBe(PortablePath.make(""));
      expect(draft.user).toBe("");
      expect(calls).toEqual(["command", "entrypoint", "workingDirectory", "user"]);
    },
  );

  test("preserves caller ordering and excluded defaults when applying a subset", () => {
    const { ctx, draft, calls } = processDraft({
      command: ["authored-command"],
      entrypoint: ["authored-entrypoint"],
      workingDirectory: PortablePath.make("/authored"),
      user: "authored-user",
    });

    applyAuthoredProcessFields(ctx, ["user", "entrypoint"]);

    expect(calls).toEqual(["user", "entrypoint"]);
    expect(draft.command).toEqual(["default-command"]);
    expect(draft.workingDirectory).toBe(PortablePath.make("/default"));
  });
});
