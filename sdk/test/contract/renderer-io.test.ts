import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { RendererNarrationIO } from "@lando/sdk/renderer";
import ts from "typescript";

test("renderer IO keeps stdout structurally outside the narration contract", async () => {
  const fixture = await Bun.file(new URL("../fixtures/sdk-mvp-surface.json", import.meta.url)).json();
  const source = ts.createSourceFile(
    "renderer.ts",
    readFileSync(new URL("../../src/renderer/index.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const members = (name: string) =>
    source.statements.flatMap((statement) =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === name
        ? statement.members.map((member) => member.name?.getText(source)).sort()
        : [],
    );
  expect(members("RendererNarrationIO")).toEqual(fixture.rendererNarrationIOMembers);
  expect(members("RendererIO")).toEqual(fixture.rendererOutputIOMembers);
  const stdoutUnavailable: Extract<
    keyof RendererNarrationIO,
    "writeStdout" | "writeStdoutBytes"
  > extends never
    ? true
    : false = true;
  expect(stdoutUnavailable).toBe(true);
});
