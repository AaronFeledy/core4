import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

type LaneId = "goal" | "qa" | "code-quality" | "security" | "context-history";
type InconclusiveClass = "timeout" | "empty-output" | "instructions-only" | "no-repo-access";

type LaneInput = {
  readonly id: LaneId;
  readonly scope: string;
  readonly inputs: readonly string[];
  readonly commandsOrTools: readonly string[];
  readonly evidence: readonly string[];
  readonly findings: readonly FindingInput[];
  readonly disposition: "approved" | "blocked" | "inconclusive";
  readonly residualRisks: readonly string[];
  readonly inconclusiveClass?: InconclusiveClass;
};

type FindingInput = {
  readonly title: string;
  readonly severity: "note" | "blocker";
  readonly sources: readonly string[];
  readonly resolution?:
    | { readonly kind: "fixed-and-re-reviewed"; readonly evidence: string }
    | {
        readonly kind: "linked-beta-story";
        readonly storyId: string;
        readonly rationale: string;
        readonly sources: readonly string[];
      };
};

type ClosureModule = {
  readonly evaluateClosureReviewInput: (input: unknown, failingStoryIds?: readonly string[]) => ClosureReport;
  readonly renderClosureReviewMarkdown: (report: ClosureReport) => string;
  readonly writeClosureReviewOutputs: (input: {
    readonly report: ClosureReport;
    readonly reportPath: string;
    readonly notePath: string;
  }) => Promise<void>;
};

type ClosureReport = {
  readonly schemaVersion: 1;
  readonly approved: boolean;
  readonly lanes: readonly {
    readonly id: LaneId;
    readonly disposition: string;
    readonly evidence: readonly string[];
  }[];
  readonly errors: readonly string[];
};

class ClosureModuleShapeError extends Error {
  constructor() {
    super("Closure review module did not expose the expected test seam.");
    this.name = "ClosureModuleShapeError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const closureModuleKeys = [
  "evaluateClosureReviewInput",
  "renderClosureReviewMarkdown",
  "writeClosureReviewOutputs",
] as const satisfies readonly (keyof ClosureModule)[];

const isClosureModule = (value: unknown): value is ClosureModule =>
  isRecord(value) && closureModuleKeys.every((key) => typeof value[key] === "function");

const loadClosureModule = async (): Promise<ClosureModule> => {
  const moduleUrl = new URL("../../../scripts/closure-review.ts", import.meta.url);
  const loaded: unknown = await import(moduleUrl.href);
  if (!isClosureModule(loaded)) throw new ClosureModuleShapeError();
  return loaded;
};

const { evaluateClosureReviewInput, renderClosureReviewMarkdown, writeClosureReviewOutputs } =
  await loadClosureModule();

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "closure-review-"));
});

afterEach(async () => {
  await rm(tempDir, { force: true, recursive: true });
});

const lane = (id: LaneId, overrides: Partial<LaneInput> = {}): LaneInput => ({
  id,
  scope: `${id} lane scope for US-431`,
  inputs: [`${id} transcript`, "spec/beta-1/prd-beta-1-13-beta-closure.md"],
  commandsOrTools: [`${id} reviewer`, "grep US-431 spec/beta-1/prd-beta-1-13-beta-closure.md"],
  evidence: [`${id} retained evidence line one`, `${id} retained evidence line two`],
  findings: [
    {
      title: `${id} no blocker`,
      severity: "note",
      sources: ["spec/beta-1/prd-beta-1-13-beta-closure.md:46"],
    },
  ],
  disposition: "approved",
  residualRisks: [`${id} residual risk accepted for Beta 1`],
  ...overrides,
});

const conclusiveInput = (): { readonly lanes: readonly LaneInput[] } => ({
  lanes: [lane("goal"), lane("qa"), lane("code-quality"), lane("security"), lane("context-history")],
});

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));

describe("US-431 closure review reporting", () => {
  test("approves five conclusive lanes and renders an auditable final note", async () => {
    const report = evaluateClosureReviewInput(conclusiveInput());
    const note = renderClosureReviewMarkdown(report);
    const reportPath = join(tempDir, "closure-review.json");
    const notePath = join(tempDir, "closure-review.md");

    await writeClosureReviewOutputs({ report, reportPath, notePath });

    expect(report).toMatchObject({ schemaVersion: 1, approved: true, errors: [] });
    expect(report.lanes.map((entry) => entry.id)).toEqual([
      "goal",
      "qa",
      "code-quality",
      "security",
      "context-history",
    ]);
    expect(report.lanes.find((entry) => entry.id === "security")?.evidence).toContain(
      "security retained evidence line two",
    );
    expect(note).toContain("goal: approved");
    expect(note).toContain("qa: approved");
    expect(note).toContain("code-quality: approved");
    expect(note).toContain("security: approved");
    expect(note).toContain("context-history: approved");
    expect(note).toContain("security retained evidence line two");
    expect(note).toContain(
      "note: security no blocker; sources: spec/beta-1/prd-beta-1-13-beta-closure.md:46",
    );
    expect(await readJson(reportPath)).toMatchObject({ schemaVersion: 1, approved: true });
    expect(await readFile(notePath, "utf8")).toContain("context-history: approved");
  });

  test.each(["timeout", "empty-output", "instructions-only", "no-repo-access"] as const)(
    "rejects %s lanes as inconclusive",
    (inconclusiveClass) => {
      const input = conclusiveInput();
      const lanes = input.lanes.map((entry) =>
        entry.id === "qa"
          ? lane("qa", { disposition: "inconclusive", evidence: [], inconclusiveClass })
          : entry,
      );

      const report = evaluateClosureReviewInput({ lanes });

      expect(report.approved).toBe(false);
      expect(report.errors).toContain(`qa lane is inconclusive: ${inconclusiveClass}`);
      expect(renderClosureReviewMarkdown(report)).toContain(`qa: inconclusive (${inconclusiveClass})`);
    },
  );

  test("rejects an approved lane carrying an inconclusive class", () => {
    const input = conclusiveInput();
    const lanes = input.lanes.map((entry) =>
      entry.id === "qa" ? lane("qa", { inconclusiveClass: "timeout" }) : entry,
    );

    const report = evaluateClosureReviewInput({ lanes });

    expect(report.approved).toBe(false);
    expect(report.errors).toContain("qa lane cannot carry an inconclusive class with approved disposition");
  });

  test("rejects blockers without fixed evidence or a currently failing Beta 1 story link", () => {
    const blocker: FindingInput = {
      title: "runtime bundle remains remote-only",
      severity: "blocker",
      sources: ["spec/beta-1/prd-beta-1-13-beta-closure.md:49"],
      resolution: {
        kind: "linked-beta-story",
        storyId: "US-430",
        rationale: "US-430 is already green, so it cannot carry this blocker.",
        sources: ["spec/beta-1/prd-beta-1-13-beta-closure.md:49"],
      },
    };
    const input = conclusiveInput();
    const lanes = input.lanes.map((entry) =>
      entry.id === "goal" ? lane("goal", { disposition: "blocked", findings: [blocker] }) : entry,
    );

    const report = evaluateClosureReviewInput({ lanes });

    expect(report.approved).toBe(false);
    expect(report.errors).toContain(
      'goal blocker "runtime bundle remains remote-only" must link to a currently failing Beta 1 story',
    );
  });

  test("rejects forged blocker links outside the authoritative failing-story set", () => {
    const forgedResolution = {
      kind: "linked-beta-story",
      storyId: "US-430",
      currentlyFailing: true,
      rationale: "Reviewer claims US-430 is still failing.",
      sources: ["spec/beta-1/prd-beta-1-13-beta-closure.md:49"],
    } as const;
    const blocker: FindingInput = {
      title: "runtime bundle remains remote-only",
      severity: "blocker",
      sources: ["spec/beta-1/prd-beta-1-13-beta-closure.md:49"],
      resolution: forgedResolution,
    };
    const input = conclusiveInput();
    const lanes = input.lanes.map((entry) =>
      entry.id === "goal" ? lane("goal", { disposition: "blocked", findings: [blocker] }) : entry,
    );

    const report = evaluateClosureReviewInput({ lanes }, ["US-431"]);

    expect(report.approved).toBe(false);
    expect(report.errors).toContain(
      'goal blocker "runtime bundle remains remote-only" must link to a currently failing Beta 1 story',
    );
  });

  test("rejects approved lanes that still contain blockers linked to failing stories", () => {
    const blocker: FindingInput = {
      title: "host proxy transport remains unwired",
      severity: "blocker",
      sources: ["spec/beta-1/prd-beta-1-13-beta-closure.md:85"],
      resolution: {
        kind: "linked-beta-story",
        storyId: "US-433",
        rationale: "The production transport gap is tracked by US-433.",
        sources: ["spec/beta-1/prd-beta-1-13-beta-closure.md:85"],
      },
    };
    const input = conclusiveInput();
    const lanes = input.lanes.map((entry) =>
      entry.id === "security" ? lane("security", { findings: [blocker] }) : entry,
    );

    const report = evaluateClosureReviewInput({ lanes }, ["US-433"]);

    expect(report.approved).toBe(false);
    expect(report.errors).toContain(
      'security blocker "host proxy transport remains unwired" remains linked to failing story US-433',
    );
  });

  test("CLI writes JSON and Markdown before returning nonzero for rejected closure", async () => {
    const inputPath = join(tempDir, "input.json");
    const reportPath = join(tempDir, "report.json");
    const notePath = join(tempDir, "note.md");
    await writeFile(inputPath, JSON.stringify({ lanes: [lane("goal")] }));
    const prdPath = join(tempDir, "prd.json");
    await writeFile(prdPath, JSON.stringify({ userStories: [{ id: "US-431", passes: false }] }));

    const proc = Bun.spawn({
      cmd: [
        "bun",
        "run",
        "scripts/closure-review.ts",
        "--input",
        inputPath,
        "--report",
        reportPath,
        "--note",
        notePath,
        "--prd",
        prdPath,
      ],
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toBe("");
    expect(stdout).toContain(reportPath);
    expect(await readJson(reportPath)).toMatchObject({ approved: false });
    expect(await readFile(notePath, "utf8")).toContain("missing required lane: qa");
  });
});
