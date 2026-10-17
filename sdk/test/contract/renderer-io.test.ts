import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type RendererIO, type RendererNarrationIO, narrationIO } from "@lando/sdk/renderer";
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

test("narration view hides stdout at runtime and tracks stderr metadata live", () => {
  // Given
  let columns = 80;
  const stderr: (string | Uint8Array)[] = [];
  const io: RendererIO = {
    writeStdout: () => {},
    writeStderr: (chunk) => {
      stderr.push(chunk);
    },
    isTTY: true,
    stdoutIsTTY: false,
    get terminalColumns() {
      return columns;
    },
  };

  // When
  const view = narrationIO(io);
  columns = 120;
  view.writeStderr("line\n");

  // Then
  expect("writeStdout" in view).toBe(false);
  expect("stdoutIsTTY" in view).toBe(false);
  expect("externalOutputStream" in view).toBe(false);
  expect(view.terminalColumns).toBe(120);
  expect(view.isTTY).toBe(true);
  expect(stderr).toEqual(["line\n"]);
  expect(narrationIO(io)).toBe(view);
  expect(narrationIO(view)).toBe(view);
});
