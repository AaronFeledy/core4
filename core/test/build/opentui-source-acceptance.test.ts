import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { removeAcceptanceRoot } from "./fixtures/opentui-acceptance-cleanup.ts";
import {
  capturedTranscript,
  cleanEnv,
  expectMachineInit,
  expectNonLoadingDispatches,
  normalizeTiming,
  probeEnv,
  readProbe,
  repoRoot,
  scrubPtyNoise,
} from "./fixtures/opentui-acceptance.ts";
import { runPrompt } from "./fixtures/opentui-prompt.ts";

describe.skipIf(process.platform === "win32")("source OpenTUI renderer-mode acceptance", () => {
  test("plain prompts and json results match their native-disabled baselines", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "lando-opentui-source-"));
    const appRoot = resolve(root, "app");
    await mkdir(appRoot);
    const baseEnv = cleanEnv(root);
    const command = [process.execPath, resolve(repoRoot, "core/bin/lando.ts")];
    try {
      const bypassTrace = resolve(root, "bypass.jsonl");
      await expectNonLoadingDispatches(command, appRoot, probeEnv(baseEnv, bypassTrace));
      expect(await readProbe(bypassTrace)).toEqual([]);
      const richTrace = resolve(root, "rich.jsonl");
      const rich = await runPrompt(command, appRoot, ["init"], probeEnv(baseEnv, richTrace));
      expect(rich).toContain("╭");
      expect(await readProbe(richTrace)).toEqual([
        { phase: "attempt", specifier: "@opentui/core" },
        { phase: "ready", specifier: "@opentui/core" },
      ]);
      for (const renderer of ["plain", "json"] as const) {
        const tracePath = resolve(root, `${renderer}.jsonl`);
        const normal = await runPrompt(
          command,
          appRoot,
          ["init", `--renderer=${renderer}`],
          probeEnv(baseEnv, tracePath),
        );
        if (renderer === "json") {
          expectMachineInit(normal, appRoot);
          await removeAcceptanceRoot(appRoot);
          await mkdir(appRoot);
        }
        const withoutOpenTui = await runPrompt(command, appRoot, ["init", `--renderer=${renderer}`], {
          ...baseEnv,
          LANDO_NO_OPENTUI_PROMPTS: "1",
        });
        expect(scrubPtyNoise(normal)).not.toContain("╭");
        if (renderer === "plain") expect(scrubPtyNoise(normal)).toContain("(value or index):");
        else expectMachineInit(withoutOpenTui, appRoot);
        expect(normalizeTiming(capturedTranscript(normal, renderer))).toBe(
          normalizeTiming(capturedTranscript(withoutOpenTui, renderer)),
        );
        expect(await readProbe(tracePath)).toEqual([]);
      }
      const failureTrace = resolve(root, "failure.jsonl");
      const degraded = await runPrompt(command, appRoot, ["init"], probeEnv(baseEnv, failureTrace, true));
      expect(degraded).toContain("(value or index):");
      expect(await readProbe(failureTrace)).toEqual([{ phase: "attempt", specifier: "@opentui/core" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
