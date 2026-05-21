import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");
const docsPath = resolve(repoRoot, "docs/alpha-install-and-bug-reports.md");
const readmePath = resolve(repoRoot, "README.md");

const readText = async (path: string): Promise<string> => Bun.file(path).text();

describe("alpha install and bug report docs", () => {
  test("document supported alpha install paths and bug report artifacts", async () => {
    const docs = await readText(docsPath);

    expect(docs).toContain("Linux x64");
    expect(docs).toContain("dev prerelease");
    expect(docs).toContain("SHA256SUMS");
    expect(docs).toContain("sha256sum -c SHA256SUMS");
    expect(docs).toContain("npm install @lando/core@dev");
    expect(docs).toContain("Linux/macOS");
    expect(docs).toContain("Windows");
    expect(docs).toContain("deferred");
    expect(docs).toContain("macOS");
    expect(docs).toContain("Beta");
    expect(docs).toContain("lando doctor");
    expect(docs).toContain("logsDir");
    expect(docs).toContain("cacheDir");
  });

  test("links alpha install docs from README", async () => {
    const readme = await readText(readmePath);

    expect(readme).toContain("docs/alpha-install-and-bug-reports.md");
  });
});
