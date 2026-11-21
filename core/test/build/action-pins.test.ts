import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { ACTION_PINS, parseActionPins } from "../../../scripts/action-pins.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const workflowsDir = resolve(repoRoot, ".github/workflows");
const USES_LINE = /^\s+(?:-\s+)?uses:\s*(?<value>.+)$/;
const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";

const workflowUses = async (): Promise<readonly { readonly where: string; readonly value: string }[]> => {
  const files = (await readdir(workflowsDir)).filter((name) => name.endsWith(".yml")).sort();
  const perFile = await Promise.all(
    files.map(async (file) =>
      (await Bun.file(resolve(workflowsDir, file)).text()).split("\n").flatMap((line, index) => {
        const value = USES_LINE.exec(line)?.groups?.value;
        return value === undefined ? [] : [{ where: `${file}:${index + 1}`, value }];
      }),
    ),
  );
  return perFile.flat();
};

describe("action pins", () => {
  test("every workflow step runs an action exactly as the pins file pins it", async () => {
    const pinned = new Set([...ACTION_PINS.values()].map((pin) => pin.uses));
    const uses = await workflowUses();

    expect(uses.filter(({ value }) => !pinned.has(value))).toEqual([]);
  });

  test("generators write no action ref of their own", async () => {
    const literal = /uses:\s+[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@/;
    const offenders: string[] = [];
    for await (const path of new Bun.Glob("scripts/**/*.ts").scan({ cwd: repoRoot })) {
      if (path === "scripts/action-pins.ts") continue;
      (await Bun.file(resolve(repoRoot, path)).text()).split("\n").forEach((line, index) => {
        if (literal.test(line)) offenders.push(`${path}:${index + 1}`);
      });
    }

    expect(offenders).toEqual([]);
  });

  test("every pin is used by a workflow", async () => {
    const used = new Set((await workflowUses()).map(({ value }) => value));

    expect([...ACTION_PINS.values()].filter((pin) => !used.has(pin.uses)).map((pin) => pin.action)).toEqual(
      [],
    );
  });

  test("accepts only a full commit labeled with an exact release, once per action", () => {
    const pins = parseActionPins(`# comment\npins:\n  - uses: actions/checkout@${SHA} # v7.0.1\n`);

    expect([...pins.values()]).toEqual([
      {
        action: "actions/checkout",
        ref: `actions/checkout@${SHA}`,
        uses: `actions/checkout@${SHA} # v7.0.1`,
      },
    ]);
    for (const line of [
      "  - uses: actions/checkout@v7 # v7.0.1",
      `  - uses: actions/checkout@${SHA}`,
      `  - uses: actions/checkout@${SHA} # v7`,
      `    - uses: actions/checkout@${SHA} # v7.0.1`,
    ]) {
      expect(() => parseActionPins(`pins:\n${line}\n`)).toThrow("expected");
    }
    const twice = `  - uses: actions/checkout@${SHA} # v7.0.1`;
    expect(() => parseActionPins(`pins:\n${twice}\n${twice}\n`)).toThrow("actions/checkout is pinned twice");
  });
});
