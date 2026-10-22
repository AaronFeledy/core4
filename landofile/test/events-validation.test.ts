import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Effect, Schema } from "effect";

import { LandofileShape } from "@lando/sdk/schema";

import { UNSUPPORTED_REMEDIATION, rejectUnsupportedToolingFeatures } from "../src/tooling-unsupported.ts";

const cliEntry = resolve(import.meta.dirname, "../../core/bin/lando.ts");
const validNames = [
  "pre-init",
  "post-init",
  "pre-start",
  "post-start",
  "pre-stop",
  "post-stop",
  "pre-restart",
  "post-restart",
  "pre-rebuild",
  "post-rebuild",
  "pre-destroy",
  "post-destroy",
  "post-pull",
  "post-push",
  "post-switch",
  "post-code-sync",
] as const;

describe("Landofile events", () => {
  test("the four event step forms decode strictly and remain mutually exclusive", () => {
    // Given
    const authored = {
      name: "events-app",
      events: {
        "pre-start": [
          "echo string",
          { cmd: "echo object", service: "appserver", env: { TOKEN: "value" }, user: "www-data" },
          { task: "prepare" },
          { command: "app:info", flags: { format: "json" }, args: { service: "appserver" } },
        ],
      },
    };

    // When
    const decoded = Schema.decodeUnknownSync(LandofileShape)(authored, { onExcessProperty: "error" });

    // Then
    expect(decoded.events?.["pre-start"]).toHaveLength(4);
    expect(() =>
      Schema.decodeUnknownSync(LandofileShape)(
        { name: "bad", events: { "pre-start": [{ cmd: "echo bad", task: "also-bad" }] } },
        { onExcessProperty: "error" },
      ),
    ).toThrow();
  });

  test("structured event fields are accepted by the unsupported-feature scanner", async () => {
    // Given
    const graduatedSteps = [
      { defer: "later" },
      { for: ["service"], cmd: "echo {{ item }}" },
      { if: "condition" },
      { command: "app:info", raw: true },
      { command: "app:info", silent: true },
      { command: "app:info", ignoreError: true },
      { task: "prepare", vars: { MODE: "fast" } },
      { task: "prepare", silent: true },
      { cmd: "pwd", dir: "/workspace" },
    ] as const;

    for (const step of graduatedSteps) {
      // When
      const outcome = await Effect.runPromise(
        Effect.result(
          rejectUnsupportedToolingFeatures("/workspace/.lando.yml", {
            events: { "pre-start": [step] },
          }),
        ),
      );

      // Then
      expect(outcome._tag).toBe("Success");
    }
  });

  test("event platforms remain rejected as unsupported", async () => {
    // Given
    const unsupportedSteps = [{ cmd: "uname", platforms: ["linux"] }] as const;

    for (const step of unsupportedSteps) {
      // When
      const outcome = await Effect.runPromise(
        Effect.result(
          rejectUnsupportedToolingFeatures("/workspace/.lando.yml", {
            events: { "pre-start": [step] },
          }),
        ),
      );

      // Then
      expect(outcome._tag).toBe("Failure");
      if (outcome._tag !== "Failure") throw new Error("expected unsupported event step failure");
      expect(outcome.failure).toMatchObject({
        _tag: "NotImplementedError",
        remediation: UNSUPPORTED_REMEDIATION,
      });
      expect(outcome.failure.message).toContain('Event step field "platforms"');
      expect(outcome.failure.message).toContain("/workspace/.lando.yml");
      expect(outcome.failure.message).not.toMatch(/\b(?:Alpha|Beta)\b/);
    }
  });

  test("lint reports an unknown event name with the lifecycle and tooling names", async () => {
    // Given
    const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-events-validation-")));
    try {
      await writeFile(
        join(dir, ".lando.yml"),
        "name: bad-events\ntooling:\n  prepare:\n    cmd: echo ready\nevents:\n  pre-serve:\n    - echo nope\n",
      );

      // When
      const proc = Bun.spawn({
        cmd: [process.execPath, cliEntry, "app:config:lint", "--format=json"],
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);

      // Then
      expect(exitCode).toBe(0);
      const envelope = JSON.parse(stdout);
      expect(envelope).toMatchObject({
        ok: true,
        result: {
          valid: false,
          violations: [
            {
              rule: "landofile.event",
              path: ["events", "pre-serve"],
              message: "Unknown app event pre-serve.",
              source: { file: join(dir, ".lando.yml"), layer: "canonical", path: ["events", "pre-serve"] },
            },
          ],
        },
      });
      expect(
        envelope.result.violations[0].suggestion.match(/Use one of: ([^.]+)\./)?.[1]?.split(", "),
      ).toEqual([...validNames, "post-prepare", "pre-prepare"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
