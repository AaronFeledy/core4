import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { SECRET_BINDING_SITES } from "@lando/landofile/secret-reference";

const repoRoot = resolve(import.meta.dirname, "../../..");

test("the secret guide table matches the shipped binding sites in order", async () => {
  // Given
  const guide = await Bun.file(resolve(repoRoot, "docs/guides/config/secret-stores.mdx")).text();
  const heading = "## Where references resolve";
  const headingIndex = guide.indexOf(heading);
  expect(headingIndex).toBeGreaterThanOrEqual(0);
  const section = guide.slice(headingIndex + heading.length).split(/^## /m)[0] ?? "";
  const listFormat = new Intl.ListFormat("en", { type: "disjunction" });
  // When
  const table = /^\| Site \| YAML path \|\r?\n\|[^\n]+\|\r?\n((?:\|[^\n]+\|(?:\r?\n|$))+)/m.exec(section);
  const rows = (table?.[1] ?? "")
    .trim()
    .split("\n")
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
  // Then
  expect(rows).toEqual(
    SECRET_BINDING_SITES.map((site) => [
      site.label.charAt(0).toUpperCase() + site.label.slice(1),
      listFormat.format(site.paths.map((path) => `\`${path}\``)),
    ]),
  );
});
