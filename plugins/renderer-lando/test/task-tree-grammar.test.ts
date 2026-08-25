import { describe, expect, test } from "bun:test";

import { TaskDetailRing } from "../src/task-detail-ring.ts";
import { csi } from "../src/task-tree-frame.ts";
import {
  SPINNER_FRAMES,
  type TaskState,
  type TaskStatus,
  type TaskTreeRenderState,
  type TreeState,
  renderLogicalFrame,
  styleFrame,
} from "../src/task-tree-render.ts";

const makeTask = (input: {
  readonly id: string;
  readonly label: string;
  readonly status: TaskStatus;
  readonly summary?: string;
  readonly durationMs?: number;
  readonly exitCode?: number;
  readonly remediation?: string;
  readonly details?: ReadonlyArray<string>;
}): TaskState => {
  const ring = new TaskDetailRing();
  for (const line of input.details ?? []) ring.push(line);
  return {
    id: input.id,
    transcriptPath: undefined,
    label: input.label,
    status: input.status,
    summary: input.summary,
    durationMs: input.durationMs,
    exitCode: input.exitCode,
    remediation: input.remediation,
    ring,
  };
};

const makeTree = (input: {
  readonly label: string;
  readonly childCount: number;
  readonly done?: boolean;
  readonly summary?: string;
  readonly succeeded?: number;
  readonly failed?: number;
  readonly durationMs?: number;
}): TreeState => ({
  parentId: "tree",
  childCount: input.childCount,
  label: input.label,
  done: input.done ?? false,
  summary: input.summary,
  succeeded: input.succeeded ?? 0,
  failed: input.failed ?? 0,
  durationMs: input.durationMs,
});

const makeState = (input: {
  readonly tree?: TreeState;
  readonly tasks: ReadonlyArray<TaskState>;
  readonly spinningTaskIds?: ReadonlyArray<string>;
  readonly spinnerFrame?: number;
  readonly expandedTaskId?: string;
  readonly expandedLines?: ReadonlyArray<string>;
  readonly terminalColumns?: number;
}): TaskTreeRenderState => ({
  tree: input.tree,
  tasks: new Map(input.tasks.map((task) => [task.id, task])),
  order: input.tasks.map((task) => task.id),
  spinningTaskIds: new Set(input.spinningTaskIds ?? []),
  spinnerFrame: input.spinnerFrame ?? 0,
  expandedTaskId: input.expandedTaskId,
  expandedLines: input.expandedLines ?? [],
  terminalColumns: input.terminalColumns ?? 80,
});

const paint = (state: TaskTreeRenderState): ReadonlyArray<string> => renderLogicalFrame(state);

const body = (start: string, end: string, text: string): string =>
  `${csi.pink}│${csi.reset}${start}${text}${end}`;

const dimDuration = (text: string): string => `${csi.dim}${text}${csi.dimReset}${csi.reset}`;

const spinnerBody = (glyph: string, label: string): string =>
  `${csi.pink}│${csi.reset}${csi.pink} ${glyph}${csi.reset}${csi.cyan} ${label}${csi.reset}`;

const contentAfterRail = (line: string | undefined): string =>
  (line ?? "").slice(`${csi.pink}│${csi.reset}`.length);

describe("quiet task-tree grammar", () => {
  test("paints identity-only title, glyph rows, and running ratio when work is live", () => {
    const frame = paint(
      makeState({
        tree: makeTree({ label: "Starting app", childCount: 2 }),
        tasks: [
          makeTask({
            id: "web",
            label: "appserver",
            status: "running",
            details: ["listening on :80"],
          }),
          makeTask({ id: "db", label: "database", status: "pending" }),
        ],
        spinningTaskIds: ["web"],
      }),
    );

    expect(frame[0]).toBe("╭─ Starting app");
    expect(frame).toContain(`│ ${SPINNER_FRAMES[0]} appserver`);
    expect(frame).toContain("│   listening on :80");
    expect(frame).toContain("│ ◌ database");
    expect(frame.at(-1)).toBe("╰─ 1/2 running");
    expect(frame.join("\n")).not.toMatch(/LANDO OPS|\[(?:RUNNING|ONLINE|WAIT|BLOCKED)\]|telemetry/);
  });

  test("paints summary title and done footer without counts when every child succeeds", () => {
    const frame = paint(
      makeState({
        tree: makeTree({
          label: "Starting app",
          childCount: 2,
          done: true,
          summary: "App online",
          succeeded: 2,
          failed: 0,
          durationMs: 842,
        }),
        tasks: [
          makeTask({
            id: "web",
            label: "appserver",
            status: "done",
            summary: "appserver ready",
            durationMs: 400,
          }),
          makeTask({
            id: "db",
            label: "database",
            status: "done",
            summary: "database ready",
            durationMs: 442,
          }),
        ],
      }),
    );

    expect(frame[0]).toBe("╭─ App online");
    expect(frame).toContain("│ ✓ appserver ready  400ms");
    expect(frame).toContain("│ ✓ database ready  442ms");
    expect(frame.at(-1)).toBe("╰─ done  842ms");
    expect(frame.join("\n")).not.toMatch(/0 failed|0 ✗|0 ok|LANDO OPS|\[ONLINE\]|telemetry/);
  });

  test("paints mixed footer, exit suffix, and remediation when one child fails", () => {
    const frame = paint(
      makeState({
        tree: makeTree({
          label: "Building",
          childCount: 2,
          done: true,
          summary: "Build blocked",
          succeeded: 1,
          failed: 1,
          durationMs: 1500,
        }),
        tasks: [
          makeTask({
            id: "web",
            label: "appserver",
            status: "done",
            summary: "appserver ready",
            durationMs: 200,
          }),
          makeTask({
            id: "db",
            label: "database",
            status: "failed",
            summary: "migration failed",
            exitCode: 1,
            durationMs: 1300,
            remediation: "run lando db:reset",
          }),
        ],
      }),
    );

    expect(frame[0]).toBe("╭─ Build blocked");
    expect(frame).toContain("│ ✓ appserver ready  200ms");
    expect(frame).toContain("│ ✗ migration failed (exit 1)  1.3s");
    expect(frame).toContain("│   ↳ run lando db:reset");
    expect(frame.at(-1)).toBe("╰─ 1 ok · 1 failed  1.5s");
    expect(frame.join("\n")).not.toMatch(/\[BLOCKED\]|telemetry|0 /);
  });

  test("omits a zero success count when every child fails", () => {
    const frame = paint(
      makeState({
        tree: makeTree({
          label: "Building",
          childCount: 2,
          done: true,
          summary: "Build failed",
          succeeded: 0,
          failed: 2,
          durationMs: 900,
        }),
        tasks: [
          makeTask({
            id: "web",
            label: "appserver",
            status: "failed",
            summary: "image missing",
            durationMs: 400,
          }),
          makeTask({ id: "db", label: "database", status: "failed", summary: "port taken", durationMs: 500 }),
        ],
      }),
    );

    expect(frame.at(-1)).toBe("╰─ 2 failed  900ms");
    expect(frame.join("\n")).not.toMatch(/0 ok|0 ✓|telemetry/);
  });

  test("rounds fractional milliseconds and keeps sub-second values off the title", () => {
    const frame = paint(
      makeState({
        tree: makeTree({
          label: "Starting app",
          childCount: 1,
          done: true,
          summary: "App online",
          succeeded: 1,
          durationMs: 12.4,
        }),
        tasks: [
          makeTask({
            id: "web",
            label: "appserver",
            status: "done",
            summary: "appserver ready",
            durationMs: 12.6,
          }),
        ],
      }),
    );

    expect(frame[0]).toBe("╭─ App online");
    expect(frame).toContain("│ ✓ appserver ready  13ms");
    expect(frame.at(-1)).toBe("╰─ done  12ms");
    expect(frame.join("\n")).not.toMatch(/12\.4|12\.6|\(\d+ms\)/);
  });

  test("paints cached and skipped as compact metadata instead of chips", () => {
    const frame = paint(
      makeState({
        tree: makeTree({
          label: "Starting app",
          childCount: 2,
          done: true,
          summary: "App online",
          succeeded: 2,
          durationMs: 80,
        }),
        tasks: [
          makeTask({
            id: "web",
            label: "appserver",
            status: "done",
            summary: "appserver ready (cached)",
            durationMs: 40,
          }),
          makeTask({
            id: "db",
            label: "database",
            status: "done",
            summary: "database ready · skipped",
            durationMs: 40,
          }),
        ],
      }),
    );

    expect(frame).toContain("│ ✓ appserver ready  cached  40ms");
    expect(frame).toContain("│ – database ready  skipped  40ms");
    expect(frame.join("\n")).not.toMatch(/\[CACHED\]|\[SKIPPED\]|\[ONLINE\]/);
  });

  test("keeps an expanded tail to title, glyph row, and tail footer", () => {
    const frame = paint(
      makeState({
        tree: makeTree({ label: "Starting app", childCount: 1 }),
        tasks: [makeTask({ id: "web", label: "appserver", status: "running" })],
        expandedTaskId: "web",
        expandedLines: ["boot line 1", "boot line 2"],
      }),
    );

    expect(frame[0]).toBe("╭─ appserver");
    expect(frame).toContain("│ · appserver");
    expect(frame).toContain("│   boot line 1");
    expect(frame).toContain("│   boot line 2");
    expect(frame.at(-1)).toBe("╰─ tail");
    expect(frame.join("\n")).not.toMatch(/LANDO OPS|expanded task tail|telemetry/);
  });

  test("styles the pink rail and semantic glyphs without status chips", () => {
    const styled = styleFrame(
      paint(
        makeState({
          tree: makeTree({
            label: "Building",
            childCount: 5,
            done: true,
            summary: "Build blocked",
            succeeded: 3,
            failed: 1,
            durationMs: 200,
          }),
          tasks: [
            makeTask({ id: "ok", label: "appserver", status: "done", summary: "appserver ready" }),
            makeTask({
              id: "cache",
              label: "cache",
              status: "done",
              summary: "cache ready (cached)",
            }),
            makeTask({
              id: "skip",
              label: "proxy",
              status: "done",
              summary: "proxy ready · skipped",
            }),
            makeTask({ id: "fail", label: "database", status: "failed", summary: "migration failed" }),
            makeTask({ id: "wait", label: "worker", status: "pending" }),
          ],
        }),
      ),
    );
    const joined = styled.join("\n");

    expect(styled[0]).toBe(`${csi.pink}╭─${csi.reset}${csi.bold} Build blocked${csi.reset}`);
    expect(styled.at(-1)).toBe(
      `${csi.pink}╰─${csi.reset}${csi.dim} 3 ok · 1 failed  200ms${csi.dimReset}${csi.reset}`,
    );
    expect(joined).toContain(`${csi.green} ✓ appserver ready`);
    expect(joined).toContain(`${csi.cyan} ✓ cache ready  cached`);
    expect(joined).toContain(`${csi.dim}${csi.cyan} – proxy ready  skipped`);
    expect(joined).toContain(`${csi.red} ✗ migration failed`);
    expect(joined).not.toMatch(/\[(?:ONLINE|CACHED|SKIPPED|BLOCKED|WAIT|RUNNING)\]/);
  });

  test("dims elapsed duration after the semantic glyph and label", () => {
    const styled = styleFrame(
      paint(
        makeState({
          tree: makeTree({
            label: "Building",
            childCount: 4,
            done: true,
            summary: "Build blocked",
            succeeded: 3,
            failed: 1,
            durationMs: 200,
          }),
          tasks: [
            makeTask({
              id: "ok",
              label: "appserver",
              status: "done",
              summary: "appserver ready",
              durationMs: 13,
            }),
            makeTask({
              id: "cache",
              label: "cache",
              status: "done",
              summary: "cache ready (cached)",
              durationMs: 40,
            }),
            makeTask({
              id: "skip",
              label: "proxy",
              status: "done",
              summary: "proxy ready · skipped",
              durationMs: 40,
            }),
            makeTask({
              id: "fail",
              label: "database",
              status: "failed",
              summary: "migration failed",
              exitCode: 1,
              durationMs: 1500,
            }),
          ],
        }),
      ),
    );

    expect(styled.find((line) => line.includes("appserver ready"))).toBe(
      `${body(csi.green, csi.reset, " ✓ appserver ready")}${dimDuration("  13ms")}`,
    );
    expect(styled.find((line) => line.includes("cache ready"))).toBe(
      `${body(csi.cyan, csi.reset, " ✓ cache ready  cached")}${dimDuration("  40ms")}`,
    );
    expect(styled.find((line) => line.includes("proxy ready"))).toBe(
      `${body(`${csi.dim}${csi.cyan}`, `${csi.dimReset}${csi.reset}`, " – proxy ready  skipped")}${dimDuration("  40ms")}`,
    );
    expect(styled.find((line) => line.includes("migration failed"))).toBe(
      `${body(csi.red, csi.reset, " ✗ migration failed (exit 1)")}${dimDuration("  1.5s")}`,
    );
    expect(styled.at(-1)).toBe(
      `${csi.pink}╰─${csi.reset}${csi.dim} 3 ok · 1 failed  200ms${csi.dimReset}${csi.reset}`,
    );
  });

  test("places the identity title first and the running footer last on first paint", () => {
    const frame = paint(
      makeState({
        tree: makeTree({ label: "Building", childCount: 3 }),
        tasks: [
          makeTask({ id: "web", label: "web", status: "pending" }),
          makeTask({ id: "db", label: "db", status: "pending" }),
          makeTask({ id: "cache", label: "cache", status: "pending" }),
        ],
      }),
    );

    expect(frame[0]).toBe("╭─ Building");
    expect(frame.slice(1, -1)).toEqual(["│ ◌ web", "│ ◌ db", "│ ◌ cache"]);
    expect(frame.at(-1)).toBe("╰─ 0/3 running");
    expect(frame.join("\n")).not.toContain("LANDO OPS");
    expect(frame[0]).not.toContain("running");
  });

  test("carries semantic row color onto wrapped continuation lines", () => {
    const styled = styleFrame([
      "╭─ Building",
      "│ ✓ appserver ready after a long operational label  13ms",
      "│ that continues without the success glyph",
      "│ ✗ migration failed with a long reason  13ms",
      "│ that continues without the failure glyph",
      "│ ✓ cache ready  cached  40ms",
      "│ after a cache wrap",
      "│ – proxy ready  skipped  40ms",
      "│ after a skip wrap",
      "│ ◌ pending worker with a long label",
      "│ after a pending wrap",
      `│ ${SPINNER_FRAMES[0]} running task with a long label`,
      "│ after a running wrap",
      "│   ↳ see lando logs node --build",
      "│   that continues as a dim detail",
      "│ ✓ mixed wrap keeps the name green",
      "│ name continuation  1.5s",
      "│ ✓ duration wraps alone",
      "│  13ms",
      "╰─ 1 ok · 1 failed",
    ]);

    expect(styled[1]).toBe(
      `${body(csi.green, csi.reset, " ✓ appserver ready after a long operational label")}${dimDuration("  13ms")}`,
    );
    expect(styled[2]).toBe(body(csi.green, csi.reset, " that continues without the success glyph"));
    expect(styled[4]).toBe(body(csi.red, csi.reset, " that continues without the failure glyph"));
    expect(styled[6]).toBe(body(csi.cyan, csi.reset, " after a cache wrap"));
    expect(styled[8]).toBe(
      body(`${csi.dim}${csi.cyan}`, `${csi.dimReset}${csi.reset}`, " after a skip wrap"),
    );
    expect(styled[10]).toBe(body(csi.amber, csi.reset, " after a pending wrap"));
    expect(styled[12]).toBe(body(csi.cyan, csi.reset, " after a running wrap"));
    expect(styled[14]).toBe(
      body(csi.dim, `${csi.dimReset}${csi.reset}`, "   that continues as a dim detail"),
    );
    expect(styled[16]).toBe(`${body(csi.green, csi.reset, " name continuation")}${dimDuration("  1.5s")}`);
    expect(styled[18]).toBe(body(csi.dim, `${csi.dimReset}${csi.reset}`, "  13ms"));
  });

  test("keeps duration-like pending and running labels in one semantic span", () => {
    const styled = styleFrame(
      paint(
        makeState({
          tree: makeTree({ label: "Building", childCount: 2 }),
          tasks: [
            makeTask({ id: "wait", label: "wait  13ms", status: "pending" }),
            makeTask({ id: "run", label: "wait  13ms", status: "running" }),
          ],
        }),
      ),
    );

    expect(styled.find((line) => line.includes("◌"))).toBe(body(csi.amber, csi.reset, " ◌ wait  13ms"));
    expect(styled.find((line) => line.includes("·"))).toBe(body(csi.cyan, csi.reset, " · wait  13ms"));
    expect(styled.at(-1)).toBe(`${csi.pink}╰─${csi.reset}${csi.dim} 1/2 running${csi.dimReset}${csi.reset}`);
  });

  test("dims a wrapped duration-only continuation only for a settled row", () => {
    const styled = styleFrame([
      "╭─ Building",
      "│ ✓ duration wraps alone",
      "│  13ms",
      "│ ◌ wait",
      "│  13ms",
      "│ · wait",
      "│  13ms",
      "╰─ 1/3 running",
    ]);

    expect(styled[2]).toBe(body(csi.dim, `${csi.dimReset}${csi.reset}`, "  13ms"));
    expect(styled[4]).toBe(body(csi.amber, csi.reset, "  13ms"));
    expect(styled[6]).toBe(body(csi.cyan, csi.reset, "  13ms"));
    expect(styled.at(-1)).toBe(`${csi.pink}╰─${csi.reset}${csi.dim} 1/3 running${csi.dimReset}${csi.reset}`);
  });

  test("paints a spinning braille glyph pink and keeps the running label cyan", () => {
    const glyph = SPINNER_FRAMES[0] ?? "⠋";
    const styled = styleFrame(
      paint(
        makeState({
          tree: makeTree({ label: "Starting app", childCount: 1 }),
          tasks: [makeTask({ id: "web", label: "appserver", status: "running" })],
          spinningTaskIds: ["web"],
        }),
      ),
    );

    expect(styled.find((line) => line.includes(glyph))).toBe(spinnerBody(glyph, "appserver"));
  });

  test("keeps the static running dot cyan without a pink content glyph", () => {
    const styled = styleFrame(
      paint(
        makeState({
          tree: makeTree({ label: "Starting app", childCount: 1 }),
          tasks: [makeTask({ id: "web", label: "appserver", status: "running" })],
        }),
      ),
    );
    const line = styled.find((row) => row.includes("·"));

    expect(line).toBe(body(csi.cyan, csi.reset, " · appserver"));
    expect(contentAfterRail(line)).not.toContain(csi.pink);
  });

  test("keeps a spinning-row wrap continuation cyan", () => {
    const styled = styleFrame([
      `│ ${SPINNER_FRAMES[0]} running task with a long label`,
      "│ after a running wrap",
    ]);

    expect(styled[1]).toBe(body(csi.cyan, csi.reset, " after a running wrap"));
    expect(contentAfterRail(styled[1])).not.toContain(csi.pink);
  });

  test("keeps settled and pending content on semantic colors instead of pink", () => {
    const styled = styleFrame([
      "│ ✓ appserver ready",
      "│ – proxy ready  skipped",
      "│ ✗ migration failed",
      "│ ◌ worker",
    ]);
    const success = styled.find((line) => line.includes("appserver ready"));
    const skipped = styled.find((line) => line.includes("skipped"));
    const failed = styled.find((line) => line.includes("migration failed"));
    const pending = styled.find((line) => line.includes("◌"));

    expect(success).toBe(body(csi.green, csi.reset, " ✓ appserver ready"));
    expect(skipped).toBe(
      body(`${csi.dim}${csi.cyan}`, `${csi.dimReset}${csi.reset}`, " – proxy ready  skipped"),
    );
    expect(failed).toBe(body(csi.red, csi.reset, " ✗ migration failed"));
    expect(pending).toBe(body(csi.amber, csi.reset, " ◌ worker"));
    for (const line of [success, skipped, failed, pending]) {
      expect(contentAfterRail(line)).not.toContain(csi.pink);
    }
  });
});
