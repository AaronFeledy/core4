import { expect, test } from "bun:test";
import { stripAnsi } from "@lando/renderer/console-layout";
import { buildInfoSummary, renderInfoAppResult } from "../../src/cli/commands/info-render.ts";
import { decorated, result, service } from "./info-storage-fixtures.ts";

test("shows artifact and user on both human surfaces while keeping the TSV base columns", () => {
  const info = result(
    service("web", undefined, {
      artifact: { kind: "ref", ref: "node:22-alpine", digest: "sha256:example" },
      user: "node",
    }),
  );
  const fields = buildInfoSummary(info).sections[0]?.rows[0]?.fields;
  expect(fields).toContainEqual({ label: "artifact", value: "node:22-alpine (sha256:example)" });
  expect(fields).toContainEqual({ label: "user", value: "node" });

  const summary = stripAnsi(renderInfoAppResult(info, decorated(160)));
  expect(summary).toContain("node:22-alpine (sha256:example)");
  expect(summary).toContain("node");

  const plain = renderInfoAppResult(info);
  expect(plain.split("\n")[1]).toBe("service\tstate\tHost\tApp Network");
  expect(plain).toContain("web\tartifact\tnode:22-alpine (sha256:example)");
  expect(plain).toContain("web\tuser\tnode");
  expect(plain.split("\n").filter((line) => line.startsWith("web\trunning\t"))).toHaveLength(1);
});

test("escapes control characters in artifact and user details", () => {
  const info = result(
    service("web", undefined, {
      artifact: { kind: "ref", ref: "node\tforged\nrow\u001b[31m" },
      user: "node\tforged\nrow\u001b[31m",
    }),
  );
  for (const text of [renderInfoAppResult(info), stripAnsi(renderInfoAppResult(info, decorated(160)))]) {
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("forged\nrow");
    expect(text).not.toContain("forged\t");
  }
});
