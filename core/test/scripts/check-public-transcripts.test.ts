import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { buildGuideScenarioAst, emitPublicTranscripts } from "../../../scripts/build-guide-scenarios.ts";

interface PublicTranscriptDiagnostic {
  readonly code: string;
  readonly message: string;
}

interface CheckPublicTranscriptsInput {
  readonly expected: ReadonlyArray<string>;
  readonly actual: ReadonlySet<string>;
}

interface PublicTranscriptCheckResult {
  readonly diagnostics: ReadonlyArray<PublicTranscriptDiagnostic>;
}

interface CheckPublicTranscriptsModule {
  readonly checkPublicTranscripts: (input: CheckPublicTranscriptsInput) => PublicTranscriptCheckResult;
  readonly checkPublicTranscriptsOnDisk: (
    root: string,
    options?: { readonly bootstrap?: boolean },
  ) => Promise<PublicTranscriptCheckResult>;
}

const loadChecker = async (): Promise<CheckPublicTranscriptsModule> => {
  const importModule = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<CheckPublicTranscriptsModule>;
  return importModule("../../../scripts/check-public-transcripts.ts");
};

const writeRenderableGuideFixture = async (root: string): Promise<void> => {
  await mkdir(join(root, "docs/guides"), { recursive: true });
  await Bun.write(
    join(root, "docs/guides/demo.mdx"),
    [
      "---",
      "id: demo",
      "provider: test",
      "---",
      "",
      "<Guide>",
      '  <Scenario id="reader-path" render>',
      '    <Step name="start">',
      '      <Run command="lando start" />',
      "    </Step>",
      "  </Scenario>",
      "</Guide>",
      "",
    ].join("\n"),
  );
  await Bun.write(
    join(root, "docs/guides/INDEX.md"),
    [
      "# Feature Coverage Matrix",
      "",
      "| PRD | US | Feature | Guide Path | Status |",
      "|---|---|---|---|---|",
      "| PRD-01 | US-001 | Demo | `docs/guides/demo.mdx` | Shipped |",
      "",
    ].join("\n"),
  );
};

describe("check:public-transcripts", () => {
  test("reports missing expected transcript artifacts", async () => {
    const { checkPublicTranscripts } = await loadChecker();
    expect(
      checkPublicTranscripts({
        expected: ["dist/transcripts/public/guides/g/s.json"],
        actual: new Set(),
      }).diagnostics,
    ).toEqual([
      {
        code: "transcript.missing",
        message:
          "Shipped guide is missing its public transcript artifact: dist/transcripts/public/guides/g/s.json",
      },
    ]);
  });

  test("passes when all expected transcript artifacts are present", async () => {
    const { checkPublicTranscripts } = await loadChecker();
    expect(
      checkPublicTranscripts({
        expected: ["a"],
        actual: new Set(["a", "b"]),
      }).diagnostics,
    ).toEqual([]);
  });

  test("bootstraps public transcripts when the corpus is empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-public-tx-bootstrap-"));
    try {
      await writeRenderableGuideFixture(root);

      const transcriptPath = join(root, "dist/transcripts/public/guides/demo/reader-path.json");
      expect(await Bun.file(transcriptPath).exists()).toBe(false);

      const { checkPublicTranscriptsOnDisk } = await loadChecker();
      expect((await checkPublicTranscriptsOnDisk(root, { bootstrap: true })).diagnostics).toEqual([]);
      expect(await Bun.file(transcriptPath).exists()).toBe(true);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("keeps missing diagnostics by default when the corpus is empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-public-tx-default-"));
    try {
      await writeRenderableGuideFixture(root);

      const { checkPublicTranscriptsOnDisk } = await loadChecker();
      expect((await checkPublicTranscriptsOnDisk(root)).diagnostics).toEqual([
        {
          code: "transcript.missing",
          message:
            "Shipped guide is missing its public transcript artifact: dist/transcripts/public/guides/demo/reader-path.json",
        },
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("checks shipped renderable guide scenarios against emitted artifacts on disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-public-tx-check-"));
    try {
      await mkdir(join(root, "docs/guides"), { recursive: true });
      await Bun.write(
        join(root, "docs/guides/demo.mdx"),
        [
          "---",
          "id: demo",
          "provider: test",
          "---",
          "",
          "<Guide>",
          '  <Scenario id="reader-path" render>',
          '    <Step name="start">',
          '      <Run command="lando start" />',
          "    </Step>",
          "  </Scenario>",
          '  <Scenario id="status" render>',
          '    <Step name="inspect">',
          '      <Run command="lando info" />',
          "    </Step>",
          "  </Scenario>",
          '  <Scenario id="notes" render={false} reason="documentation-only scenario covered elsewhere">',
          '    <Step name="note">',
          '      <Run command="lando info" />',
          "    </Step>",
          "  </Scenario>",
          "</Guide>",
          "",
        ].join("\n"),
      );
      await Bun.write(
        join(root, "docs/guides/INDEX.md"),
        [
          "# Feature Coverage Matrix",
          "",
          "| PRD | US | Feature | Guide Path | Status |",
          "|---|---|---|---|---|",
          "| PRD-01 | US-001 | Demo | `docs/guides/demo.mdx` | Shipped |",
          "",
        ].join("\n"),
      );

      await emitPublicTranscripts(await buildGuideScenarioAst(root), root);
      const { checkPublicTranscriptsOnDisk } = await loadChecker();
      expect((await checkPublicTranscriptsOnDisk(root)).diagnostics).toEqual([]);

      await rm(join(root, "dist/transcripts/public/guides/demo/reader-path.json"));
      const result = await checkPublicTranscriptsOnDisk(root, { bootstrap: true });
      expect(result.diagnostics).toEqual([
        {
          code: "transcript.missing",
          message:
            "Shipped guide is missing its public transcript artifact: dist/transcripts/public/guides/demo/reader-path.json",
        },
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
