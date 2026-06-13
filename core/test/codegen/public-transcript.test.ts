import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { PublicTranscript } from "@lando/sdk/docs/components";

import { buildGuideScenarioAst, emitPublicTranscripts } from "../../../scripts/build-guide-scenarios.ts";

const readTranscript = async (root: string, relativePath: string) =>
  Schema.decodeUnknownSync(PublicTranscript)(JSON.parse(await Bun.file(join(root, relativePath)).text()));

describe("build-guide-scenarios public transcript emission", () => {
  test("emits reader-visible frames and excludes hidden, fixture, variable, and test-only content", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-public-tx-"));
    try {
      await mkdir(join(root, "docs/guides"), { recursive: true });
      await Bun.write(
        join(root, "docs/guides/pubtx-demo.mdx"),
        [
          "---",
          "id: pubtx-demo",
          "provider: test",
          "---",
          "",
          "<Guide>",
          '  <Scenario id="reader-path" render>',
          '    <Step name="start">',
          '      <Variable name="svc" value="web" display="primary service" />',
          '      <UseFixture name="demo" />',
          '      <Run command="lando start" />',
          '      <Verify event="post-start" />',
          "      <Inspect output />",
          "    </Step>",
          '    <Step name="sample">',
          '      <Inline lang="yaml" code="name: app" justification="show the minimal Landofile" />',
          "    </Step>",
          '    <Hidden reason="internal setup not shown to readers">',
          '      <Step name="secret-setup">',
          '        <Run command="lando version" />',
          "      </Step>",
          "    </Hidden>",
          '    <Step name="teardown">',
          "      <Cleanup />",
          '      <Run command="lando destroy -y" />',
          "    </Step>",
          "  </Scenario>",
          "",
          '  <Scenario id="notes" render={false} reason="documentation-only scenario covered elsewhere">',
          '    <Step name="note">',
          '      <Variable name="x" value="y" display="z" />',
          "    </Step>",
          "  </Scenario>",
          "</Guide>",
          "",
        ].join("\n"),
      );

      const asts = await buildGuideScenarioAst(root);
      const written = await emitPublicTranscripts(asts, root);

      expect(written).toEqual(["dist/transcripts/public/guides/pubtx-demo/reader-path.json"]);

      const transcript = await readTranscript(
        root,
        "dist/transcripts/public/guides/pubtx-demo/reader-path.json",
      );

      expect(transcript.guideId).toBe("pubtx-demo");
      expect(transcript.scenarioId).toBe("reader-path");
      expect(transcript.variant).toBe("");
      expect(transcript.runtime).toBe("cli");
      expect(transcript.render).toBe(true);

      expect(transcript.frames.map((frame) => frame.kind)).toEqual([
        "step",
        "run",
        "verify",
        "inspect",
        "step",
        "inline",
        "step",
        "cleanup",
        "run",
      ]);

      for (const frame of transcript.frames) {
        expect(frame.sourceFile).toBe("docs/guides/pubtx-demo.mdx");
        expect(frame.sourceLine).toBeGreaterThan(0);
      }

      const runFrame = transcript.frames.find((frame) => frame.kind === "run");
      expect(runFrame?.commandDisplay).toBe("lando start");
      expect(runFrame?.resultSummary).toBe("expected exit 0");

      const verifyFrame = transcript.frames.find((frame) => frame.kind === "verify");
      expect(verifyFrame?.resultSummary).toBe('event "post-start" observed');

      const inlineFrame = transcript.frames.find((frame) => frame.kind === "inline");
      expect(inlineFrame?.displayText).toBe("inline yaml");
      expect(inlineFrame?.commandDisplay).toBe("name: app");

      const serialized = JSON.stringify(transcript);
      expect(serialized).not.toContain("secret-setup");
      expect(serialized).not.toContain("lando version");
      expect(serialized).not.toContain("fixture");
      expect(serialized).not.toContain("primary service");
      expect(transcript.frames.map((frame) => frame.displayText)).toEqual([
        "start",
        undefined,
        undefined,
        "inspect output",
        "sample",
        "inline yaml",
        "teardown",
        "cleanup",
        undefined,
      ]);

      expect(
        await Bun.file(join(root, "dist/transcripts/public/guides/pubtx-demo/notes.json")).exists(),
      ).toBe(false);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("emits per-variant public transcripts with tab frames and only the selected tab's steps", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-public-tx-tabs-"));
    try {
      await mkdir(join(root, "docs/guides"), { recursive: true });
      await Bun.write(
        join(root, "docs/guides/tabs.mdx"),
        [
          "---",
          "id: tabs-guide",
          "provider: test",
          "tabs: [linux, macos]",
          "---",
          "",
          "<Guide>",
          '  <Scenario id="main" render>',
          '    <Step name="prepare">',
          '      <Run command="lando version" />',
          "    </Step>",
          "    <Tabs>",
          '      <Tab name="linux">',
          '        <Step name="install">',
          '          <Run command="lando version" />',
          "        </Step>",
          "      </Tab>",
          '      <Tab name="macos">',
          '        <Step name="install">',
          '          <Run command="lando version" />',
          "        </Step>",
          '        <Step name="brew">',
          '          <Run command="lando version" />',
          "        </Step>",
          "      </Tab>",
          "    </Tabs>",
          "  </Scenario>",
          "</Guide>",
          "",
        ].join("\n"),
      );

      const asts = await buildGuideScenarioAst(root);
      const written = await emitPublicTranscripts(asts, root);

      expect(written).toEqual([
        "dist/transcripts/public/guides/tabs-guide/main.linux.json",
        "dist/transcripts/public/guides/tabs-guide/main.macos.json",
      ]);

      const linux = await readTranscript(root, "dist/transcripts/public/guides/tabs-guide/main.linux.json");
      const macos = await readTranscript(root, "dist/transcripts/public/guides/tabs-guide/main.macos.json");

      expect(linux.variant).toBe("default=linux");
      expect(macos.variant).toBe("default=macos");

      const linuxTab = linux.frames.find((frame) => frame.kind === "tab");
      expect(linuxTab?.displayText).toBe("default=linux");

      const linuxSteps = linux.frames.filter((frame) => frame.kind === "step").map((f) => f.displayText);
      const macosSteps = macos.frames.filter((frame) => frame.kind === "step").map((f) => f.displayText);
      expect(linuxSteps).toEqual(["prepare", "install"]);
      expect(macosSteps).toEqual(["prepare", "install", "brew"]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
