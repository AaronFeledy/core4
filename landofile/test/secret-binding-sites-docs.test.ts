import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { SECRET_BINDING_SITES } from "../src/secret-reference.ts";

const repoRoot = resolve(import.meta.dirname, "../..");

test("the secret guide table matches the shipped binding sites in order", async () => {
  // Given
  const guide = await Bun.file(resolve(repoRoot, "docs/guides/config/secret-stores.mdx")).text();
  const listFormat = new Intl.ListFormat("en", { type: "disjunction" });
  // When
  const table = [
    "| Site | YAML path |",
    "| --- | --- |",
    ...SECRET_BINDING_SITES.map(
      (site) =>
        `| ${site.label.charAt(0).toUpperCase() + site.label.slice(1)} | ${listFormat.format(site.paths.map((path) => `\`${path}\``))} |`,
    ),
  ].join("\n");
  // Then
  expect(guide, `Paste this binding-site table into the guide:\n${table}`).toContain(table);
});
