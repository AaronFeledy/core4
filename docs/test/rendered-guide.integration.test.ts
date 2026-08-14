import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const ROOT = join(import.meta.dir, "..", "..");
const DOCS_DIST = join(ROOT, "docs", "dist");
const MISSING_TRANSCRIPT = join(
  ROOT,
  "dist",
  "transcripts",
  "public",
  "guides",
  "e2e-smoke-scenarios",
  "compiled-provider-smoke.json",
);
const CAPTURED_PAGE = join(DOCS_DIST, "guides", "recipes", "canonical-public-transcript", "index.html");
const MISSING_PAGE = join(DOCS_DIST, "guides", "authoring", "e2e-smoke-scenarios", "index.html");

let capturedHtml = "";
let missingHtml = "";
let allHtml = "";
let buildExitCode = -1;
let transcriptBytes: Uint8Array | undefined;

beforeAll(async () => {
  // Given: fresh public transcripts with one rendered scenario intentionally left uncaptured.
  const codegen = Bun.spawnSync(["bun", "run", "codegen:guide-scenarios"], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(codegen.exitCode).toBe(0);
  transcriptBytes = await Bun.file(MISSING_TRANSCRIPT).bytes();
  await unlink(MISSING_TRANSCRIPT);

  // When: Astro builds the production site from the remaining real transcript artifacts.
  const build = Bun.spawnSync(["bun", "run", "--filter=@lando/docs", "build"], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  buildExitCode = build.exitCode;
  capturedHtml = await readFile(CAPTURED_PAGE, "utf8");
  missingHtml = await readFile(MISSING_PAGE, "utf8");

  const htmlFiles = new Bun.Glob("**/*.html").scan({ cwd: DOCS_DIST, absolute: true });
  const pages: string[] = [];
  for await (const path of htmlFiles) pages.push(await readFile(path, "utf8"));
  allHtml = pages.join("\n");
}, 300_000);

afterAll(async () => {
  if (transcriptBytes !== undefined) await writeFile(MISSING_TRANSCRIPT, transcriptBytes);
});

describe("rendered guide transcripts", () => {
  test("renders captured run and verify frames inside their vocabulary wrappers", () => {
    // Then: captured commands and summaries stay attached to their authored components.
    expect(capturedHtml).toMatch(
      /class="lando-run"[^>]*>[\s\S]*?lando app:config:lint --format=json[\s\S]*?expected exit 0[\s\S]*?<\/div>/,
    );
    expect(capturedHtml).toMatch(
      /class="lando-verify"[^>]*>[\s\S]*?lando app:config:lint --format=json[\s\S]*?command &quot;lando app:config:lint --format=json&quot; succeeds[\s\S]*?<\/div>/,
    );
  });

  test("renders the authored command and placeholder when a transcript is absent", () => {
    // Then: a missing capture is visible and does not fail the build.
    expect(buildExitCode).toBe(0);
    expect(missingHtml).toMatch(
      /class="lando-run"[^>]*>[\s\S]*?lando start[\s\S]*?No captured output yet[\s\S]*?<\/div>/,
    );
  });

  test("renders step names as headings", () => {
    // Then: scenario structure remains navigable semantic content.
    expect(capturedHtml).toContain("<h3>scaffold-recipe</h3>");
    expect(capturedHtml).toContain("<h3>validate-config</h3>");
  });

  test("omits hidden and render-false guide content from every emitted page", () => {
    // Then: the production site contains no hidden vocabulary or hidden scenario wrapper.
    expect(allHtml).not.toContain("lando-hidden");
    expect(allHtml).not.toContain('data-scenario-id="invalid-service-type"');
  });

  test("links captured frames to their authored guide source line", () => {
    // Then: readers can inspect the exact source that produced a captured frame.
    expect(capturedHtml).toContain('href="docs/guides/recipes/canonical-public-transcript.mdx#L23"');
  });
});
