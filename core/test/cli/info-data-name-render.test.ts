import { expect, test } from "bun:test";
import { stripAnsi } from "@lando/renderer/console-layout";
import { renderInfoAppResult } from "../../src/cli/commands/info-render.ts";
import { decorated } from "./info-storage-fixtures.ts";

test("info renders the app-level data name once in each human format", () => {
  const info = { app: "current", dataName: "original", services: [] };
  const plain = renderInfoAppResult(info);
  const terminal = stripAnsi(renderInfoAppResult(info, decorated(120)));
  expect(plain.match(/original/g)).toHaveLength(1);
  expect(terminal.match(/original/g)).toHaveLength(1);
  expect(plain).toContain("current");
  expect(terminal).toContain("current");
});
