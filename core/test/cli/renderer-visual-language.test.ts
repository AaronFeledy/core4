import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";

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
import { EventService } from "@lando/sdk/services";

import { makeLandoEventConsumer } from "../../../plugins/renderer-lando/src/renderer-runtime.ts";
import { createBufferedRendererIO } from "../../src/cli/renderer/io.ts";
import { makeJsonRendererLive, renderPlain } from "../../src/cli/renderer/runtime.ts";
import { TaskTreeViewModel } from "../../src/cli/renderer/task-tree-tail.ts";
import { EventServiceLive } from "../../src/services/event-service.ts";

class RecordingLiveRegion {
  readonly footers: string[][] = [];
  readonly scrollback: string[] = [];
  setFooter(lines: ReadonlyArray<string>): void {
    this.footers.push([...lines]);
  }
  commitScrollback(text: string): void {
    this.scrollback.push(text);
  }
  requestLive(): void {}
  dropLive(): void {}
  resize(): void {}
  enterFullTail(): void {}
  exitFullTail(): void {}
  reset(): void {}
  dispose(): void {}
}

const substrateIo = (base: ReturnType<typeof createBufferedRendererIO>) => ({
  ...base,
  externalOutputStream: { write: () => true } as unknown as NodeJS.WriteStream,
});

const ts = "2026-06-18T12:00:00.000Z";
const escapeChar = String.fromCharCode(27);
const ansiPattern = new RegExp(`${escapeChar}\\[[0-9;]*[A-Za-z]`, "g");
const repoRoot = resolve(import.meta.dirname, "../../..");

const stripAnsi = (line: string): string => line.replace(ansiPattern, "");

const taskTreeStart = (label: string, children: ReadonlyArray<string>): LandoEvent =>
  Schema.decodeUnknownSync(TaskTreeStartEvent)({
    _tag: "task.tree.start",
    parentId: "visual-fixture",
    label,
    children,
    timestamp: ts,
  });

const taskStart = (taskId: string, label: string): LandoEvent =>
  Schema.decodeUnknownSync(TaskStartEvent)({
    _tag: "task.start",
    parentId: "visual-fixture",
    taskId,
    label,
    timestamp: ts,
  });

const detail = (taskId: string, line: string, stream: "stdout" | "stderr" = "stdout"): LandoEvent =>
  Schema.decodeUnknownSync(TaskDetailEvent)({
    _tag: "task.detail",
    taskId,
    stream,
    line,
    timestamp: ts,
  });

const taskComplete = (taskId: string, summary: string, durationMs = 42): LandoEvent =>
  Schema.decodeUnknownSync(TaskCompleteEvent)({
    _tag: "task.complete",
    taskId,
    summary,
    durationMs,
    timestamp: ts,
  });

const taskFail = (taskId: string, summary: string, remediation: string): LandoEvent =>
  Schema.decodeUnknownSync(TaskFailEvent)({
    _tag: "task.fail",
    taskId,
    summary,
    exitCode: 1,
    remediation,
    durationMs: 1310,
    timestamp: ts,
  });

const taskTreeComplete = (summary: string, succeeded: number, failed: number): LandoEvent =>
  Schema.decodeUnknownSync(TaskTreeCompleteEvent)({
    _tag: "task.tree.complete",
    parentId: "visual-fixture",
    summary,
    succeeded,
    failed,
    durationMs: 1520,
    timestamp: ts,
  });

const setupPlanEvents = (): ReadonlyArray<LandoEvent> => [
  taskTreeStart("Setting up Lando runtime", ["bundle", "proxy", "state"]),
  taskStart("bundle", "Verify runtime bundle"),
  detail("bundle", "SHA256 verified from local release manifest"),
  taskComplete("bundle", "Verify runtime bundle"),
  taskStart("proxy", "Probe corporate proxy and custom CA trust"),
  detail(
    "proxy",
    "using LANDO_NETWORK_CA_CERTS=/very/long/path/to/corporate/root/authority.pem with NO_PROXY=github.com,registry.npmjs.org",
  ),
  taskComplete("proxy", "Proxy and CA trust ready"),
  taskStart("state", "Persist setup readiness summary"),
  detail("state", "readiness.json updated without secrets"),
];

const failureEvents = (): ReadonlyArray<LandoEvent> => [
  taskTreeStart("Building app dependencies", ["appserver", "node", "queue"]),
  taskStart("appserver", "composer install"),
  taskStart("node", "npm ci"),
  detail("node", "npm warn deprecated foo@1.0.0", "stderr"),
  taskComplete("appserver", "composer install", 12400),
  taskFail("node", "npm ci", "see lando logs node --build"),
  taskTreeComplete("Build blocked", 1, 1),
];

const uninstallEvents = (): ReadonlyArray<LandoEvent> => [
  taskTreeStart("Preview uninstall plan", ["runtime", "data"]),
  taskStart("runtime", "Remove managed provider runtime"),
  taskComplete("runtime", "Managed runtime removable"),
  taskStart("data", "Preserve user data roots in keep-data mode"),
  detail("data", "manual: rerun with --purge to remove owned caches"),
  taskComplete("data", "User data preserved"),
  taskTreeComplete("Uninstall plan ready", 2, 0),
];

const longLabelEvents = (): ReadonlyArray<LandoEvent> => [
  taskTreeStart(
    "Setting up Lando runtime with an intentionally long mission-control heading that must stay inside the panel",
    ["proxy"],
  ),
  taskStart("proxy", "Probe corporate proxy and custom CA trust with a long operational label"),
  detail(
    "proxy",
    "using LANDO_NETWORK_CA_CERTS=/very/long/path/to/corporate/root/authority.pem with NO_PROXY=github.com,registry.npmjs.org,packages.example.internal",
  ),
  taskTreeComplete("Lando runtime ready after validating proxy and CA configuration", 1, 0),
];

const messageWarn = (body: string): LandoEvent =>
  Schema.decodeUnknownSync(MessageWarnEvent)({ _tag: "message.warn", body, timestamp: ts });

const successEvents = (): ReadonlyArray<LandoEvent> => [
  taskTreeStart("Starting app", ["appserver", "database"]),
  taskStart("appserver", "appserver"),
  taskComplete("appserver", "appserver online", 820),
  taskStart("database", "database"),
  taskComplete("database", "database online", 540),
  taskTreeComplete("App online", 2, 0),
];

const drivePainter = (events: ReadonlyArray<LandoEvent>, columns: number): ReadonlyArray<string> => {
  const vm = new TaskTreeViewModel({ terminalColumns: columns });
  for (const event of events) vm.apply(event);
  expect(vm.frameLines().map(stripAnsi)).toEqual([...vm.snapshot().frameLines]);
  return vm.snapshot().frameLines;
};

const maxFrameWidth = (lines: ReadonlyArray<string>): number =>
  lines.reduce((max, line) => Math.max(max, stripAnsi(line).length), 0);

describe("lando renderer visual language", () => {
  test("renders spaceship-console status text and panel separators for setup, failure, uninstall, and active work", () => {
    for (const events of [setupPlanEvents(), failureEvents(), uninstallEvents()]) {
      for (const columns of [80, 100, 120]) {
        const frame = drivePainter(events, columns).join("\n");
        expect(frame).toContain("LANDO OPS");
        expect(frame).toContain("╭─");
        expect(frame).toContain("╰─");
        expect(frame).toContain("│");
        expect(frame).toMatch(/\[(RUNNING|ONLINE|BLOCKED|WAIT)\]/);
      }
    }
  });

  test("keeps narrow 80-column frames readable and never communicates status by color alone", () => {
    const frame = drivePainter(setupPlanEvents(), 80);
    expect(maxFrameWidth(frame)).toBeLessThanOrEqual(80);
    expect(frame.join("\n")).toContain("[ONLINE]");
    expect(frame.join("\n")).toContain("[RUNNING]");
  });

  test("keeps all golden fixtures within their target terminal width", () => {
    for (const events of [setupPlanEvents(), failureEvents(), uninstallEvents(), longLabelEvents()]) {
      for (const columns of [80, 100, 120]) {
        const frame = drivePainter(events, columns);
        expect(maxFrameWidth(frame), `${columns} columns\n${frame.join("\n")}`).toBeLessThanOrEqual(columns);
      }
    }
  });

  test("preserves hanging indentation for wrapped detail rows", () => {
    const frame = drivePainter(longLabelEvents(), 80);
    const detailRows = frame.filter(
      (line) => line.includes("LANDO_NETWORK_CA_CERTS") || line.includes("NO_PROXY"),
    );
    expect(detailRows.length).toBeGreaterThan(1);
    for (const line of detailRows) {
      expect(line).toStartWith("│   ");
    }
  });

  test("TTY lando output includes ANSI accents while non-TTY fallback remains plain", async () => {
    const events = failureEvents();

    const controller = new RecordingLiveRegion();
    const tty = substrateIo(createBufferedRendererIO({ isTTY: true, terminalColumns: 100 }));
    const program = Effect.gen(function* () {
      const service = yield* EventService;
      for (const event of events) yield* service.publish(event);
      yield* Effect.sleep("20 millis");
    });
    await Effect.runPromise(
      Effect.scoped(
        program.pipe(
          Effect.provide(
            Layer.provideMerge(
              makeLandoEventConsumer(tty, { createLiveRegion: () => Promise.resolve(controller) }),
              EventServiceLive,
            ),
          ),
        ),
      ),
    );
    const substrateOutput = [...controller.footers.flat(), ...controller.scrollback].join("\n");
    expect(substrateOutput).toContain(`${escapeChar}[`);
    expect(stripAnsi(substrateOutput)).toContain("LANDO OPS");

    const plain = createBufferedRendererIO();
    renderPlain(plain, events);
    expect(plain.stdout()).not.toContain("LANDO OPS");
    expect(plain.stdout()).not.toContain(`${escapeChar}[`);
  });

  test("renders an all-online success summary with text status, never color alone", () => {
    for (const columns of [80, 100, 120]) {
      const frame = drivePainter(successEvents(), columns);
      const joined = frame.join("\n");
      expect(joined).toContain("LANDO OPS");
      expect(joined).toContain("[ONLINE]");
      expect(joined).toContain("(2 ✓ · 0 ✗)");
      expect(joined).not.toContain("[BLOCKED]");
      expect(maxFrameWidth(frame)).toBeLessThanOrEqual(columns);
    }
  });

  test("warnings carry a text glyph in TTY output and stay plain in non-TTY fallback", async () => {
    const events = [...successEvents(), messageWarn("runtime bundle checksum is using a placeholder")];

    const controller = new RecordingLiveRegion();
    const tty = substrateIo(createBufferedRendererIO({ isTTY: true, terminalColumns: 100 }));
    const program = Effect.gen(function* () {
      const service = yield* EventService;
      for (const event of events) yield* service.publish(event);
      yield* Effect.sleep("20 millis");
    });
    await Effect.runPromise(
      Effect.scoped(
        program.pipe(
          Effect.provide(
            Layer.provideMerge(
              makeLandoEventConsumer(tty, { createLiveRegion: () => Promise.resolve(controller) }),
              EventServiceLive,
            ),
          ),
        ),
      ),
    );
    expect(controller.scrollback.map(stripAnsi).join("\n")).toContain(
      "⚠ runtime bundle checksum is using a placeholder",
    );

    const plain = createBufferedRendererIO();
    renderPlain(plain, events);
    expect(plain.stdout()).toContain("⚠ runtime bundle checksum is using a placeholder");
    expect(plain.stdout()).not.toContain(`${escapeChar}[`);
  });

  test("json renderer stays undecorated NDJSON with no spaceship styling", async () => {
    const events = failureEvents();
    const io = createBufferedRendererIO();
    const program = Effect.gen(function* () {
      const service = yield* EventService;
      for (const event of events) yield* service.publish(event);
      yield* Effect.sleep("20 millis");
    });
    await Effect.runPromise(
      Effect.scoped(
        program.pipe(Effect.provide(Layer.provideMerge(makeJsonRendererLive(io), EventServiceLive))),
      ),
    );
    const lines = io.stderrLines();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
      expect(line).not.toContain("LANDO OPS");
      expect(line).not.toContain("╭─");
      expect(line).not.toContain(escapeChar);
    }
    expect(io.stdout()).toBe("");
  });
});

describe("renderer visual language docs", () => {
  test("terminal UI polish guide publishes the spaceship-console tokens", () => {
    const guide = readFileSync(resolve(repoRoot, "docs/guides/cli/terminal-ui-polish.mdx"), "utf8");
    for (const token of [
      "deep-space",
      "cyan/teal telemetry accents",
      "[RUNNING]",
      "[ONLINE]",
      "[CACHED]",
      "[SKIPPED]",
      "[BLOCKED]",
      "[WAIT]",
      "80 columns",
      "plain, json, non-TTY, and CI output stay undecorated",
      "LANDO OPS headings",
      "two-space row rhythm",
      "glyph plus text status",
      "dimmed detail tails",
      "progress rails stay semantic",
      "no undifferentiated rainbow logs",
      "no SaaS-purple gradients",
      "no dense ASCII art",
      "no decorative motion",
    ]) {
      expect(guide).toContain(token);
    }
  });

  test("plugin authoring guide points renderer authors at @lando/renderer-lando", () => {
    const guide = readFileSync(resolve(repoRoot, "docs/guides/plugins/authoring-new-plugin.mdx"), "utf8");
    expect(guide).toContain("@lando/renderer-lando");
    expect(guide).toContain("contributes.renderers");
  });
});
