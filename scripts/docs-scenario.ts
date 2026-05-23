#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { NotImplementedError } from "../sdk/src/errors/index.ts";
import { type GuideScenarioAst, buildGuideScenarioAst } from "./build-guide-scenarios.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const GENERATOR_PATH = resolve(import.meta.dirname, "build-guide-scenarios.ts");
const GENERATED_ROOT = "test/scenarios/generated/guides";

interface DocsScenarioOptions {
  readonly guideId: string;
  readonly scenarioId?: string;
  readonly keep: boolean;
  readonly debug: boolean;
  readonly explain: boolean;
}

const betaFlags = new Set(["--variant", "--step", "--fixture", "--update-transcript"]);

const usage = (): string => "lando docs:scenario <guideId> [--scenario <id>]";

const betaFlagError = (flag: string): NotImplementedError =>
  new NotImplementedError({
    message: `${flag} is not implemented for docs:scenario in Alpha 2.`,
    commandId: "docs:scenario",
    specSection: "§19.12",
    remediation: `${flag} ships in Phase 3 Beta — see spec/ROADMAP.md.`,
  });

const formatError = (error: unknown): string => {
  if (error instanceof NotImplementedError) {
    return [
      `code: ${error._tag}`,
      error.message,
      `commandId: ${error.commandId}`,
      `specSection: ${error.specSection}`,
      `remediation: ${error.remediation}`,
    ].join("\n");
  }
  return error instanceof Error ? error.message : String(error);
};

const parseArgs = (args: ReadonlyArray<string>): DocsScenarioOptions => {
  const [guideId, ...rest] = args;
  if (guideId === undefined || guideId.startsWith("--")) {
    throw Object.assign(new Error(usage()), { exitCode: 2 });
  }

  const options: { guideId: string; scenarioId?: string; keep: boolean; debug: boolean; explain: boolean } = {
    guideId,
    keep: false,
    debug: false,
    explain: false,
  };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === undefined) continue;
    const flag = arg.split("=", 1)[0] ?? arg;
    if (betaFlags.has(flag)) throw betaFlagError(flag);
    if (arg === "--keep") {
      options.keep = true;
      continue;
    }
    if (arg === "--debug") {
      options.debug = true;
      continue;
    }
    if (arg === "--explain") {
      options.explain = true;
      continue;
    }
    if (arg === "--scenario") {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--scenario requires an id");
      options.scenarioId = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--scenario=")) {
      options.scenarioId = arg.slice("--scenario=".length);
      continue;
    }
    if (arg.startsWith("--")) throw betaFlagError(flag);
    throw new Error(`Unexpected argument: ${arg}`);
  }

  return options;
};

const run = async (
  cmd: ReadonlyArray<string>,
  env: Record<string, string | undefined> = {},
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  const proc = Bun.spawn({
    cmd,
    cwd: REPO_ROOT,
    env: { ...process.env, ...env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

const selectedGuide = async (guideId: string): Promise<GuideScenarioAst> => {
  const guide = (await buildGuideScenarioAst(REPO_ROOT, { onlyGuide: guideId }))[0];
  if (guide === undefined) throw new Error(`Guide not found: ${guideId}`);
  return guide;
};

const scenarioPath = (guideId: string, scenarioId?: string): string =>
  scenarioId === undefined
    ? `${GENERATED_ROOT}/${guideId}/`
    : `${GENERATED_ROOT}/${guideId}/${scenarioId}.test.ts`;

const planLines = (guide: GuideScenarioAst, scenarioId?: string): ReadonlyArray<string> => {
  const scenarios = guide.scenarios.filter(
    (scenario) => scenarioId === undefined || scenario.id === scenarioId,
  );
  return scenarios.flatMap((scenario) => [
    `Guide: ${guide.frontmatter.id}`,
    `Scenario: ${scenario.id}`,
    `Render: ${scenario.render}`,
    `Source: ${guide.sourcePath}:${scenario.line}`,
    ...scenario.steps.map((step) => {
      const components = step.components.map((component) => component.kind).join(", ");
      return `Step: ${step.stepName} (${components})`;
    }),
  ]);
};

const debugLines = async (guide: GuideScenarioAst, scenarioId?: string): Promise<ReadonlyArray<string>> => {
  const scenarios = guide.scenarios.filter(
    (scenario) => scenarioId === undefined || scenario.id === scenarioId,
  );
  const lines: string[] = [];
  for (const scenario of scenarios) {
    const generatedPath = scenarioPath(guide.frontmatter.id, scenario.id);
    const content = await readFile(resolve(REPO_ROOT, generatedPath), "utf8");
    lines.push(`Generated: ${generatedPath}`);
    lines.push(
      `Source map: ${content
        .split("\n")
        .filter((line) => line.trim().startsWith("// @source:"))
        .map((line) => line.trim().replace("// @source: ", ""))
        .join(", ")}`,
    );
    for (const step of scenario.steps) {
      for (const component of step.components) {
        if (component.kind === "Variable") {
          lines.push(
            `Variable: ${component.props.name} value=${component.props.value} display=${component.props.display ?? ""}`,
          );
        }
        if (component.kind === "UseFixture") {
          lines.push(`Fixture: ${component.props.name} -> <testDir>/${component.props.name}`);
        }
      }
    }
  }
  return lines;
};

const main = async (): Promise<void> => {
  try {
    const options = parseArgs(Bun.argv.slice(2));
    const guide = await selectedGuide(options.guideId);
    if (options.explain) {
      process.stdout.write(`${planLines(guide, options.scenarioId).join("\n")}\n`);
      return;
    }

    const generated = await run([process.execPath, "run", GENERATOR_PATH, "--only", options.guideId]);
    if (generated.exitCode !== 0) {
      process.stderr.write(generated.stderr || generated.stdout);
      process.exitCode = generated.exitCode;
      return;
    }

    if (options.debug) process.stdout.write(`${(await debugLines(guide, options.scenarioId)).join("\n")}\n`);

    const test = await run(
      [process.execPath, "test", scenarioPath(options.guideId, options.scenarioId)],
      options.keep ? { KEEP_SCENARIO_DIRS: "1", LANDO_DOCS_SCENARIO_KEEP: "1" } : {},
    );
    process.stdout.write(test.stdout);
    process.stderr.write(test.stderr);
    process.exitCode = test.exitCode;
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n`);
    process.exitCode =
      typeof (error as { exitCode?: unknown }).exitCode === "number"
        ? (error as { exitCode: number }).exitCode
        : 1;
  }
};

await main();
