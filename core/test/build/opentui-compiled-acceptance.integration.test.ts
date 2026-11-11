import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, resolve } from "node:path";
import { opentuiNativeCatalog } from "../../../scripts/generated/opentui-native/catalog.generated.ts";
import { removeAcceptanceRoot, withAcceptanceCleanup } from "./fixtures/opentui-acceptance-cleanup.ts";
import {
  capturedTranscript,
  cleanEnv,
  expectMachineInit,
  expectNonLoadingDispatches,
  normalizeTiming,
  probeEnv,
  readProbe,
  scrubPtyNoise,
} from "./fixtures/opentui-acceptance.ts";
import { runPrompt } from "./fixtures/opentui-prompt.ts";

const binaryPath = process.env.LANDO_OPENTUI_ACCEPTANCE_BINARY;
const releaseTarget = process.env.LANDO_RELEASE_TARGET;
const enabled = binaryPath !== undefined && releaseTarget !== undefined;

const nativeAssetPattern = (target: string): RegExp => {
  if (target.startsWith("darwin-")) return /\/\$bunfs\/root\/libopentui-[a-z0-9]+\.dylib/gu;
  if (target.startsWith("linux-")) return /\/\$bunfs\/root\/libopentui-[a-z0-9]+\.so/gu;
  if (target.startsWith("windows-")) return /B:\/~BUN\/root\/opentui-[a-z0-9]+\.dll/gu;
  throw new Error(`Unsupported OpenTUI acceptance target: ${target}.`);
};

describe.skipIf(!enabled)("compiled OpenTUI release-target acceptance", () => {
  test("embeds one native asset and drives only the default renderer through a relocated PTY", async () => {
    const target = releaseTarget as string;
    const sourceBinary = resolve(binaryPath as string);
    const binaryText = await Bun.file(sourceBinary).text();
    const embeddedAssets = new Set(binaryText.match(nativeAssetPattern(target)) ?? []);
    const selectedRoot =
      opentuiNativeCatalog.targetToNativeRoot[target as keyof typeof opentuiNativeCatalog.targetToNativeRoot];
    if (selectedRoot === undefined) throw new Error(`Missing native-root mapping for ${target}.`);
    expect([...embeddedAssets]).toHaveLength(1);
    expect(binaryText).toContain(selectedRoot);

    const adjacent = await readdir(dirname(sourceBinary));
    expect(adjacent.some((entry) => [".so", ".dylib", ".dll"].includes(extname(entry)))).toBe(false);
    expect(adjacent).not.toContain("node_modules");

    const root = await mkdtemp(resolve(tmpdir(), `lando-opentui-${target}-`));
    const binaryRoot = await mkdtemp(resolve(tmpdir(), `lando-opentui-binary-${target}-`));
    const relocatedBinary = resolve(binaryRoot, process.platform === "win32" ? "lando.exe" : "lando");
    const appRoot = resolve(root, "app");
    const baseEnv = cleanEnv(root);
    await withAcceptanceCleanup([root, binaryRoot], async () => {
      await copyFile(sourceBinary, relocatedBinary);
      await mkdir(appRoot);
      const bypassTrace = resolve(root, "bypass.jsonl");
      await expectNonLoadingDispatches([relocatedBinary], appRoot, probeEnv(baseEnv, bypassTrace));
      expect(await readProbe(bypassTrace)).toEqual([]);

      const richTrace = resolve(root, "rich.jsonl");
      const rich = await runPrompt([relocatedBinary], appRoot, ["init"], probeEnv(baseEnv, richTrace));
      expect(rich).toContain("Pick a recipe");
      expect(rich).toContain("╭");
      expect(await readProbe(richTrace)).toEqual([
        { phase: "attempt", specifier: "@opentui/core" },
        { phase: "ready", specifier: "@opentui/core", nativeRoot: selectedRoot },
      ]);

      for (const renderer of ["plain", "json"] as const) {
        const tracePath = resolve(root, `${renderer}.jsonl`);
        const normal = await runPrompt(
          [relocatedBinary],
          appRoot,
          ["init", `--renderer=${renderer}`],
          probeEnv(baseEnv, tracePath),
        );
        if (renderer === "json") {
          expectMachineInit(normal, appRoot);
          await removeAcceptanceRoot(appRoot);
          await mkdir(appRoot);
        }
        const withoutOpenTui = await runPrompt(
          [relocatedBinary],
          appRoot,
          ["init", `--renderer=${renderer}`],
          { ...baseEnv, LANDO_NO_OPENTUI_PROMPTS: "1" },
        );
        expect(scrubPtyNoise(normal)).not.toContain("╭");
        if (renderer === "plain") expect(scrubPtyNoise(normal)).toContain("(value or index):");
        else expectMachineInit(withoutOpenTui, appRoot);
        expect(normalizeTiming(capturedTranscript(normal, renderer))).toBe(
          normalizeTiming(capturedTranscript(withoutOpenTui, renderer)),
        );
        expect(await readProbe(tracePath)).toEqual([]);
      }

      const failureTrace = resolve(root, "failure.jsonl");
      const degraded = await runPrompt(
        [relocatedBinary],
        appRoot,
        ["init"],
        probeEnv(baseEnv, failureTrace, true),
      );
      expect(degraded).toContain("(value or index):");
      expect(await readProbe(failureTrace)).toEqual([{ phase: "attempt", specifier: "@opentui/core" }]);
    });
  }, 120_000);
});
