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

  test("emits public transcript frames for e2e smoke scenarios", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-public-tx-e2e-"));
    try {
      await mkdir(join(root, "docs/guides"), { recursive: true });
      await Bun.write(
        join(root, "docs/guides/e2e-smoke.mdx"),
        [
          "---",
          "id: e2e-smoke",
          "provider: test",
          "defaultLayer: e2e",
          'tags: ["@smoke"]',
          "---",
          "",
          "<Guide>",
          '  <Scenario id="provider-path" render>',
          '    <Step name="version">',
          '      <Run command="version" />',
          "    </Step>",
          '    <Step name="teardown">',
          "      <Cleanup />",
          '      <Run command="destroy -y" />',
          "    </Step>",
          "  </Scenario>",
          "</Guide>",
          "",
        ].join("\n"),
      );

      const asts = await buildGuideScenarioAst(root);
      const written = await emitPublicTranscripts(asts, root);
      const transcript = await readTranscript(
        root,
        "dist/transcripts/public/guides/e2e-smoke/provider-path.json",
      );

      expect(written).toEqual(["dist/transcripts/public/guides/e2e-smoke/provider-path.json"]);
      expect(transcript.runtime).toBe("e2e");
      expect(transcript.frames.map((frame) => frame.kind)).toEqual(["step", "run", "step", "cleanup", "run"]);
      expect(transcript.frames.every((frame) => frame.sourceFile === "docs/guides/e2e-smoke.mdx")).toBe(true);
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
      const macosTab = macos.frames.find((frame) => frame.kind === "tab");
      expect(linuxTab?.displayText).toBe("default=linux");
      expect(linuxTab?.sourceLine).not.toBe(macosTab?.sourceLine);
      expect(linuxTab?.sourceLine).toBeGreaterThan(8);

      const linuxSteps = linux.frames.filter((frame) => frame.kind === "step").map((f) => f.displayText);
      const macosSteps = macos.frames.filter((frame) => frame.kind === "step").map((f) => f.displayText);
      expect(linuxSteps).toEqual(["prepare", "install"]);
      expect(macosSteps).toEqual(["prepare", "install", "brew"]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("does not interpolate hidden-step variables into visible public frames", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-public-tx-hidden-"));
    try {
      await mkdir(join(root, "docs/guides"), { recursive: true });
      await Bun.write(
        join(root, "docs/guides/leak.mdx"),
        [
          "---",
          "id: leak-guide",
          "provider: test",
          "---",
          "",
          "<Guide>",
          '  <Scenario id="leak-check" render>',
          '    <Hidden reason="hidden setup defines a secret variable">',
          '      <Step name="setup">',
          '        <Variable name="secret" value="s3cr3t-value" display="secret" />',
          "      </Step>",
          "    </Hidden>",
          '    <Step name="deploy">',
          '      <Run command="lando deploy {{secret}}" />',
          "    </Step>",
          "  </Scenario>",
          "</Guide>",
          "",
        ].join("\n"),
      );

      const asts = await buildGuideScenarioAst(root);
      await emitPublicTranscripts(asts, root);
      const transcript = await readTranscript(
        root,
        "dist/transcripts/public/guides/leak-guide/leak-check.json",
      );

      expect(JSON.stringify(transcript)).not.toContain("s3cr3t-value");
      const runFrame = transcript.frames.find((frame) => frame.kind === "run");
      expect(runFrame?.commandDisplay).not.toContain("s3cr3t-value");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("redacts machine data and secrets from emitted public transcript artifacts (US-249)", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-public-tx-redact-"));
    try {
      await mkdir(join(root, "docs/guides"), { recursive: true });
      await Bun.write(
        join(root, "docs/guides/redact-emit.mdx"),
        [
          "---",
          "id: redact-emit",
          "provider: test",
          "---",
          "",
          "<Guide>",
          '  <Scenario id="cli-leak" render>',
          '    <Step name="start">',
          '      <Variable name="root" value="/home/aaron/lando" display="root" />',
          "      <Run command=\"lando start --root {{root}} --fixture core/test/cli/fixtures/deferred-commands.json -t=shorttoken -k 'short-key' --token s3cr3t\" />",
          "    </Step>",
          "  </Scenario>",
          '  <Scenario id="lib-leak" render>',
          '    <Step name="lib">',
          '      <Run runtime="library" code={`console.log("ok");`} displayCode={`LandoCore.from("/tmp/lando-xyz", "token secret")`} />',
          "    </Step>",
          "  </Scenario>",
          "</Guide>",
          "",
        ].join("\n"),
      );

      const asts = await buildGuideScenarioAst(root);
      const written = await emitPublicTranscripts(asts, root);

      expect(written).toContain("dist/transcripts/public/guides/redact-emit/cli-leak.json");
      expect(written).toContain("dist/transcripts/public/guides/redact-emit/lib-leak.json");

      const cliTx = await readTranscript(root, "dist/transcripts/public/guides/redact-emit/cli-leak.json");
      const jsonCli = JSON.stringify(cliTx);
      expect(jsonCli).not.toContain("/home/aaron");
      expect(jsonCli).not.toContain("core/test/cli/fixtures/deferred-commands.json");
      expect(jsonCli).not.toContain("shorttoken");
      expect(jsonCli).not.toContain("short-key");
      expect(jsonCli).not.toContain("s3cr3t");
      const cliRun = cliTx.frames.find((f) => f.kind === "run");
      expect(cliRun?.commandDisplay).toContain("<HOME>");
      expect(cliRun?.commandDisplay).toContain("[REDACTED]");
      expect(cliRun?.commandDisplay).toContain("-t=[REDACTED]");
      expect(cliRun?.commandDisplay).toContain("-k [REDACTED]");
      expect(cliTx.frames.every((f) => f.sourceFile === "docs/guides/redact-emit.mdx")).toBe(true);
      expect(cliTx.frames.every((f) => typeof f.sourceLine === "number" && f.sourceLine > 0)).toBe(true);

      const libTx = await readTranscript(root, "dist/transcripts/public/guides/redact-emit/lib-leak.json");
      const jsonLib = JSON.stringify(libTx);
      expect(jsonLib).not.toContain("/tmp/lando-xyz");
      expect(jsonLib).not.toContain("token secret");
      const libRun = libTx.frames.find((f) => f.kind === "run");
      expect(libRun?.commandDisplay).toContain("<TMP>");
      expect(libRun?.commandDisplay).toContain("[REDACTED]");
      expect(libTx.frames.every((f) => f.sourceFile === "docs/guides/redact-emit.mdx")).toBe(true);
      expect(libTx.frames.every((f) => typeof f.sourceLine === "number" && f.sourceLine > 0)).toBe(true);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("emits library runtime public transcripts for all-library scenarios", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-public-tx-library-"));
    try {
      await mkdir(join(root, "docs/guides"), { recursive: true });
      await Bun.write(
        join(root, "docs/guides/library.mdx"),
        [
          "---",
          "id: public-library-guide",
          "provider: test",
          "---",
          "",
          "<Guide>",
          '  <Scenario id="reader-path" render>',
          '    <Step name="read">',
          '      <Run runtime="library" code={`expect(1).toBe(1);`} displayCode={`import { FileSystem } from "@lando/core";`} />',
          "    </Step>",
          "  </Scenario>",
          "</Guide>",
          "",
        ].join("\n"),
      );

      const asts = await buildGuideScenarioAst(root);
      const written = await emitPublicTranscripts(asts, root);
      expect(written).toEqual(["dist/transcripts/public/guides/public-library-guide/reader-path.json"]);
      const transcript = await readTranscript(
        root,
        "dist/transcripts/public/guides/public-library-guide/reader-path.json",
      );

      expect(transcript.runtime).toBe("library");
      const runFrame = transcript.frames.find((frame) => frame.kind === "run");
      expect(runFrame?.kind).toBe("run");
      expect(runFrame?.commandDisplay).toBe('import { FileSystem } from "@lando/core";');
      expect(runFrame?.resultSummary).toBe("library code executed");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("keeps cli runtime public transcripts for all-cli scenarios", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-public-tx-cli-runtime-"));
    try {
      await mkdir(join(root, "docs/guides"), { recursive: true });
      await Bun.write(
        join(root, "docs/guides/cli.mdx"),
        [
          "---",
          "id: public-cli-guide",
          "provider: test",
          "---",
          "",
          "<Guide>",
          '  <Scenario id="reader-path" render>',
          '    <Step name="run">',
          '      <Run command="lando version" />',
          "    </Step>",
          "  </Scenario>",
          "</Guide>",
          "",
        ].join("\n"),
      );

      const asts = await buildGuideScenarioAst(root);
      const written = await emitPublicTranscripts(asts, root);
      expect(written).toEqual(["dist/transcripts/public/guides/public-cli-guide/reader-path.json"]);
      const transcript = await readTranscript(
        root,
        "dist/transcripts/public/guides/public-cli-guide/reader-path.json",
      );
      expect(transcript.runtime).toBe("cli");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("rejects mixed cli and library run scenarios", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-public-tx-mixed-runtime-"));
    try {
      await mkdir(join(root, "docs/guides"), { recursive: true });
      await Bun.write(
        join(root, "docs/guides/mixed.mdx"),
        [
          "---",
          "id: public-mixed-guide",
          "provider: test",
          "---",
          "",
          "<Guide>",
          '  <Scenario id="reader-path" render>',
          '    <Step name="run-cli">',
          '      <Run command="lando version" />',
          "    </Step>",
          '    <Step name="run-library">',
          '      <Run runtime="library" code={`expect(1).toBe(1);`} displayCode={`library sample`} />',
          "    </Step>",
          "  </Scenario>",
          "</Guide>",
          "",
        ].join("\n"),
      );

      const asts = await buildGuideScenarioAst(root);
      let message = "";
      try {
        await emitPublicTranscripts(asts, root);
      } catch (error) {
        message = String(error);
      }
      expect(message).toMatch(/mixed|library|cli|public-mixed-guide|reader-path/i);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("redacts secrets, paths, ids, ports, and host-specific data from public frames for determinism and safety", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-public-tx-redact-"));
    try {
      await mkdir(join(root, "docs/guides"), { recursive: true });
      await Bun.write(
        join(root, "docs/guides/redact-demo.mdx"),
        [
          "---",
          "id: redact-demo",
          "provider: test",
          "---",
          "",
          "<Guide>",
          '  <Scenario id="leak-test" render>',
          '    <Step name="leak">',
          '      <Run command="setup /tmp/lando-redact-xyz /home/redactuser/.config :65432 deadbeefcafebabe1234567890abcdef --token=sk_live_ABCDEF1234567890ABCDEF --password=mysecretvalue123" />',
          "    </Step>",
          "  </Scenario>",
          "</Guide>",
          "",
        ].join("\n"),
      );

      const asts = await buildGuideScenarioAst(root);
      const written = await emitPublicTranscripts(asts, root);
      expect(written).toEqual(["dist/transcripts/public/guides/redact-demo/leak-test.json"]);

      const transcript = await readTranscript(
        root,
        "dist/transcripts/public/guides/redact-demo/leak-test.json",
      );

      const serialized = JSON.stringify(transcript);

      expect(serialized).not.toContain("/tmp/lando-redact-xyz");
      expect(serialized).not.toContain("/home/redactuser");
      expect(serialized).not.toContain(":65432");
      expect(serialized).not.toContain("deadbeefcafebabe1234567890abcdef");
      expect(serialized).not.toContain("sk_live_ABCDEF1234567890ABCDEF");
      expect(serialized).not.toContain("mysecretvalue123");

      const runFrame = transcript.frames.find((frame) => frame.kind === "run");
      const cmd = runFrame?.commandDisplay ?? "";
      expect(cmd).toContain("<TMP>");
      expect(cmd).toContain("<HOME>");
      expect(cmd).toContain("<PORT>");
      expect(cmd).toContain("<CONTAINER_ID>");
      expect(cmd).toContain("[REDACTED]");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
