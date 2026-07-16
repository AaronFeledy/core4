/**
 * Terminal-renderer visual QA harness.
 *
 * Captures deterministic, human-readable golden reference frames for the
 * default `lando` renderer surfaces shipped by the terminal-UI-polish work
 * (task-tree progress + grouped result summaries) and produces readable diffs
 * that classify spacing, color-token, truncation, and wide-character drift.
 *
 * The harness is provider/network/host free: task-tree frames come from the
 * synchronous `TaskTreeViewModel.frameLines` result and summaries from
 * `formatSummary`, both driven by injected, fixed-timestamp render events.
 *
 * Goldens are committed under `__goldens__/` as tokenized text: ANSI SGR codes
 * are rewritten to readable `⟨name⟩` markers so a reviewer can read the frame
 * (and reject visually drab output) and a color-token regression shows up as a
 * marker change in the text diff. Width invariants are always asserted on the
 * ANSI-stripped raw frame, never on the tokenized string.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { Schema } from "effect";

import {
  type LandoEvent,
  MessageWarnEvent,
  TaskCompleteEvent,
  TaskDetailEvent,
  TaskFailEvent,
  TaskStartEvent,
  TaskTreeCompleteEvent,
  TaskTreeStartEvent,
} from "@lando/sdk/events";

import { displayWidth, stripAnsi } from "../../../src/cli/renderer/console-layout.ts";
import { type SummaryDocument, formatSummary } from "../../../src/cli/renderer/summary.ts";
import { TaskTreeViewModel } from "../../../src/cli/renderer/task-tree-tail.ts";

export { displayWidth, stripAnsi };

const ESC = String.fromCharCode(27);
const ansiPattern = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g");

/** Readable token emitted for each known SGR (color/intensity) escape code. */
const SGR_MARKERS: Record<string, string> = {
  "0": "reset",
  "1": "bold",
  "2": "dim",
  "22": "dim-off",
  "31": "red",
  "32": "green",
  "33": "amber",
  "36": "cyan",
  "95": "pink",
};

/**
 * Rewrite ANSI SGR escapes into readable inline markers. No raw escape byte
 * ever survives.
 */
export const tokenizeAnsi = (text: string): string =>
  text.replace(ansiPattern, (match) => {
    const body = match.slice(2, -1); // strip ESC[ and trailing 'm'
    const codes = body === "" ? ["0"] : body.split(";");
    return codes.map((code) => `⟨${SGR_MARKERS[code] ?? `sgr:${code}`}⟩`).join("");
  });

const splitFrameLines = (frame: string): ReadonlyArray<string> => {
  const lines = frame.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
};

/** Result of capturing a renderer surface: styled bytes, tokenized golden, and stripped lines. */
export interface CapturedFrame {
  /** Raw styled frame containing ANSI SGR only. */
  readonly styled: string;
  /** Tokenized, human-readable golden text (committed to `__goldens__/`). */
  readonly tokenized: string;
  /** ANSI-stripped visible lines, for width-invariant assertions. */
  readonly lines: ReadonlyArray<string>;
}

const buildCaptured = (rawFrame: string): CapturedFrame => {
  const styled = rawFrame;
  const lines = splitFrameLines(stripAnsi(styled));
  const tokenized = splitFrameLines(tokenizeAnsi(rawFrame)).join("\n");
  return { styled, tokenized, lines };
};

/**
 * Capture the final task-tree frame for an injected event sequence at a fixed
 * width. Uses the synchronous `TaskTreeViewModel.frameLines` result (no event
 * service, no timers, no provider) so the result is deterministic.
 */
export const captureTreeFrame = (events: ReadonlyArray<LandoEvent>, columns: number): CapturedFrame => {
  const vm = new TaskTreeViewModel({ terminalColumns: columns });
  for (const event of events) vm.apply(event);
  return buildCaptured(vm.frameLines().join("\n"));
};

/** Capture a grouped result summary at a fixed width (already styled by `formatSummary`). */
export const captureSummaryFrame = (doc: SummaryDocument, columns: number): CapturedFrame =>
  buildCaptured(formatSummary(doc, { columns }));

// ---------------------------------------------------------------------------
// Fixture catalog — the surfaces owned by the terminal-UI-polish work.
// Fixed timestamps + fixed durations keep every capture deterministic.
// ---------------------------------------------------------------------------

const ts = "2026-06-18T12:00:00.000Z";

const treeStart = (label: string, children: ReadonlyArray<string>): LandoEvent =>
  Schema.decodeUnknownSync(TaskTreeStartEvent)({
    _tag: "task.tree.start",
    parentId: "visual-fixture",
    label,
    children,
    timestamp: ts,
  });

const start = (taskId: string, label: string): LandoEvent =>
  Schema.decodeUnknownSync(TaskStartEvent)({
    _tag: "task.start",
    parentId: "visual-fixture",
    taskId,
    label,
    timestamp: ts,
  });

const detail = (taskId: string, line: string, stream: "stdout" | "stderr" = "stdout"): LandoEvent =>
  Schema.decodeUnknownSync(TaskDetailEvent)({ _tag: "task.detail", taskId, stream, line, timestamp: ts });

const complete = (taskId: string, summary: string, durationMs = 42): LandoEvent =>
  Schema.decodeUnknownSync(TaskCompleteEvent)({
    _tag: "task.complete",
    taskId,
    summary,
    durationMs,
    timestamp: ts,
  });

const fail = (taskId: string, summary: string, remediation: string): LandoEvent =>
  Schema.decodeUnknownSync(TaskFailEvent)({
    _tag: "task.fail",
    taskId,
    summary,
    exitCode: 1,
    remediation,
    durationMs: 1310,
    timestamp: ts,
  });

const treeComplete = (summary: string, succeeded: number, failed: number): LandoEvent =>
  Schema.decodeUnknownSync(TaskTreeCompleteEvent)({
    _tag: "task.tree.complete",
    parentId: "visual-fixture",
    summary,
    succeeded,
    failed,
    durationMs: 1520,
    timestamp: ts,
  });

export const warn = (body: string): LandoEvent =>
  Schema.decodeUnknownSync(MessageWarnEvent)({ _tag: "message.warn", body, timestamp: ts });

/** A named task-tree fixture: an injected event sequence plus the widths it is captured at. */
export interface TreeFixture {
  readonly id: string;
  readonly events: ReadonlyArray<LandoEvent>;
  readonly widths: ReadonlyArray<number>;
}

const STANDARD_WIDTHS = [80, 100, 120] as const;

export const TREE_FIXTURES: ReadonlyArray<TreeFixture> = [
  {
    id: "success",
    widths: STANDARD_WIDTHS,
    events: [
      treeStart("Starting app", ["appserver", "database"]),
      start("appserver", "appserver"),
      complete("appserver", "appserver online", 820),
      start("database", "database"),
      complete("database", "database online", 540),
      treeComplete("App online", 2, 0),
    ],
  },
  {
    id: "build-failure",
    widths: STANDARD_WIDTHS,
    events: [
      treeStart("Building app dependencies", ["appserver", "node", "queue"]),
      start("appserver", "composer install"),
      start("node", "npm ci"),
      detail("node", "npm warn deprecated foo@1.0.0", "stderr"),
      complete("appserver", "composer install", 12400),
      fail("node", "npm ci", "see lando logs node --build"),
      treeComplete("Build blocked", 1, 1),
    ],
  },
  {
    id: "setup-plan",
    widths: STANDARD_WIDTHS,
    events: [
      treeStart("Setting up Lando runtime", ["bundle", "proxy", "state"]),
      start("bundle", "Verify runtime bundle"),
      detail("bundle", "SHA256 verified from local release manifest"),
      complete("bundle", "Verify runtime bundle"),
      start("proxy", "Probe corporate proxy and custom CA trust"),
      detail(
        "proxy",
        "using LANDO_NETWORK_CA_CERTS=/very/long/path/to/corporate/root/authority.pem with NO_PROXY=github.com,registry.npmjs.org",
      ),
      complete("proxy", "Proxy and CA trust ready"),
      start("state", "Persist setup readiness summary"),
      detail("state", "readiness.json updated without secrets"),
    ],
  },
  {
    id: "uninstall-plan",
    widths: STANDARD_WIDTHS,
    events: [
      treeStart("Preview uninstall plan", ["runtime", "data"]),
      start("runtime", "Remove managed provider runtime"),
      complete("runtime", "Managed runtime removable"),
      start("data", "Preserve user data roots in keep-data mode"),
      detail("data", "manual: rerun with --purge to remove owned caches"),
      complete("data", "User data preserved"),
      treeComplete("Uninstall plan ready", 2, 0),
    ],
  },
  {
    id: "long-label",
    widths: STANDARD_WIDTHS,
    events: [
      treeStart(
        "Setting up Lando runtime with an intentionally long mission-control heading that must stay inside the panel",
        ["proxy"],
      ),
      start("proxy", "Probe corporate proxy and custom CA trust with a long operational label"),
      detail(
        "proxy",
        "using LANDO_NETWORK_CA_CERTS=/very/long/path/to/corporate/root/authority.pem with NO_PROXY=github.com,registry.npmjs.org,packages.example.internal",
      ),
      treeComplete("Lando runtime ready after validating proxy and CA configuration", 1, 0),
    ],
  },
];

/** A named summary fixture: a typed result document plus the widths it is captured at. */
export interface SummaryFixture {
  readonly id: string;
  readonly doc: SummaryDocument;
  readonly widths: ReadonlyArray<number>;
}

export const SUMMARY_FIXTURES: ReadonlyArray<SummaryFixture> = [
  {
    id: "uninstall-keep-data",
    widths: [60, 80, 100],
    doc: {
      title: "UNINSTALL PLAN",
      tone: "warn",
      subtitle: "dry-run · keep-data",
      sections: [
        {
          title: "toolchain",
          rows: [
            {
              label: "managed provider runtime",
              tone: "skipped",
              value: "skipped",
              detail: "Remove Lando-managed runtime bundles when present.",
              fields: [{ label: "target", value: "/home/u/.local/share/lando/providers/lando" }],
            },
            { label: "installed binary", tone: "ok", value: "owned by Lando" },
          ],
        },
        {
          title: "data",
          rows: [
            { label: "user data roots", tone: "skipped", value: "preserved" },
            { label: "owned caches", tone: "pending", value: "rerun with --purge" },
          ],
        },
      ],
      nextSteps: ["Rerun `lando uninstall --yes` after reviewing this plan."],
      footer: "11 steps reviewed",
    },
  },
  {
    id: "app-info-cjk",
    // 50 columns places a wide CJK glyph at the truncation boundary so wide-char
    // handling is genuinely exercised, not merely present.
    widths: [50, 80],
    doc: {
      title: "APP INFO",
      tone: "info",
      subtitle: "myapp · running",
      sections: [
        {
          title: "services",
          rows: [
            { label: "你好世界-appserver", tone: "ok", value: "running" },
            { label: "데이터베이스-primary", tone: "warn", value: "starting" },
            { label: "キャッシュ-redis", tone: "ok", value: "running" },
          ],
        },
        {
          title: "urls",
          rows: [
            {
              label: "appserver",
              tone: "ok",
              value: "https://myapp.lando.site",
              fields: [{ label: "internal", value: "http://appserver.myapp.internal:8080" }],
            },
          ],
        },
      ],
      footer: "3 services · 1 url",
    },
  },
  {
    id: "setup-readiness-redaction",
    widths: [70, 100],
    doc: {
      title: "SETUP READINESS",
      tone: "error",
      subtitle: "provider · podman",
      sections: [
        {
          title: "steps",
          rows: [
            { label: "runtime bundle", tone: "ok", value: "verified" },
            {
              label: "proxy",
              tone: "error",
              value: "failed",
              detail: "setup failed: connect to [redacted] failed",
            },
            { label: "shell integration", tone: "pending", value: "not run" },
          ],
        },
      ],
      nextSteps: ["Resolve the proxy trust error, then rerun `lando setup`."],
      footer: "1 of 3 steps ready",
    },
  },
];

// ---------------------------------------------------------------------------
// Golden corpus IO + readable diff.
// ---------------------------------------------------------------------------

const GOLDEN_DIR = resolve(import.meta.dirname, "__goldens__");

/** Env flag that opts into regenerating committed goldens; CI never sets it. */
export const isGoldenUpdateMode = (): boolean => process.env.LANDO_UPDATE_VISUAL_QA === "1";

/** Stable golden filename for a fixture surface at a given width. */
export const goldenName = (kind: "tree" | "summary", id: string, columns: number): string =>
  `${kind}.${id}.${columns}col.txt`;

const goldenPath = (name: string): string => resolve(GOLDEN_DIR, name);

/**
 * Read a committed golden, or — only under `LANDO_UPDATE_VISUAL_QA=1` — write
 * the captured frame and return it. In the default (CI) path a missing golden
 * is a hard failure, never a silent create.
 */
export const readOrWriteGolden = (name: string, captured: string): string => {
  const path = goldenPath(name);
  if (isGoldenUpdateMode()) {
    writeFileSync(path, `${captured}\n`, "utf8");
    return captured;
  }
  try {
    return readFileSync(path, "utf8").replace(/\n$/, "");
  } catch {
    throw new Error(
      `Missing visual-QA golden: ${name}. Regenerate with LANDO_UPDATE_VISUAL_QA=1 bun test core/test/cli/renderer/visual-qa.test.ts`,
    );
  }
};

/** The four regression classes the readable diff is required to identify. */
export type RegressionClass = "spacing" | "color-token" | "truncation" | "wide-character";

const ELLIPSIS = "…";

const classifyLine = (expected: string, actual: string): ReadonlyArray<RegressionClass> => {
  const classes = new Set<RegressionClass>();
  const expVisible = stripAnsi(expected.replace(/⟨[^⟩]*⟩/g, ""));
  const actVisible = stripAnsi(actual.replace(/⟨[^⟩]*⟩/g, ""));

  // color-token: the ⟨marker⟩ sequence changed.
  const tokens = (line: string): string => (line.match(/⟨[^⟩]*⟩/g) ?? []).join("");
  if (tokens(expected) !== tokens(actual)) classes.add("color-token");

  // truncation: ellipsis appeared/disappeared, i.e. clipping changed.
  if (expVisible.includes(ELLIPSIS) !== actVisible.includes(ELLIPSIS)) classes.add("truncation");

  // wide-character: the visible display width drifted (a wide glyph counted as
  // 1 instead of 2, or a CJK cell added/removed) while the glyph stream differs.
  if (displayWidth(expVisible) !== displayWidth(actVisible)) {
    const hasWide = (line: string): boolean => [...line].some((ch) => displayWidth(ch) === 2);
    if (hasWide(expVisible) || hasWide(actVisible)) classes.add("wide-character");
  }

  // spacing: the trimmed text matches but the raw (padding/alignment) differs.
  if (expVisible !== actVisible && expVisible.trimEnd() === actVisible.trimEnd()) {
    classes.add("spacing");
  }
  // Any residual visible difference that is not otherwise classified is spacing
  // (alignment/padding drift) so a regression is never silently unlabeled.
  if (expVisible !== actVisible && classes.size === 0) classes.add("spacing");

  return [...classes];
};

const widthRuler = (width: number): string => {
  let ruler = "";
  for (let col = 1; col <= width; col += 1) ruler += col % 10 === 0 ? "|" : col % 5 === 0 ? "+" : ".";
  return ruler;
};

/**
 * Produce a readable, CI-friendly diff between a committed golden and a fresh
 * capture. Includes per-line markers, a column ruler, the visible display
 * width of each side, and an explicit classification of every changed line so
 * spacing / color-token / truncation / wide-character regressions are obvious.
 */
export const diffGolden = (label: string, expected: string, actual: string, columns: number): string => {
  const expLines = expected.split("\n");
  const actLines = actual.split("\n");
  const total = Math.max(expLines.length, actLines.length);
  const out: string[] = [];
  out.push(`Visual QA mismatch: ${label} (width ${columns})`);
  out.push(`ruler: ${widthRuler(columns)}`);
  const allClasses = new Set<RegressionClass>();
  for (let i = 0; i < total; i += 1) {
    const exp = expLines[i] ?? "<missing>";
    const act = actLines[i] ?? "<missing>";
    if (exp === act) continue;
    const classes = classifyLine(exp, act);
    for (const c of classes) allClasses.add(c);
    const expW = displayWidth(stripAnsi(exp.replace(/⟨[^⟩]*⟩/g, "")));
    const actW = displayWidth(stripAnsi(act.replace(/⟨[^⟩]*⟩/g, "")));
    out.push(`line ${i + 1} [${classes.join(", ") || "changed"}]`);
    out.push(`  - golden (w=${expW}): ${exp}`);
    out.push(`  + actual (w=${actW}): ${act}`);
  }
  out.push(`regression classes: ${[...allClasses].join(", ") || "none"}`);
  return out.join("\n");
};
