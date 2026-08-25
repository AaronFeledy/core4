import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { CliCommandErrorEvent, CliCommandInitEvent, CliCommandRunEvent } from "@lando/sdk/events";
import type { LandoEvent } from "@lando/sdk/services";

import {
  isProvisionalStartupCommand,
  provisionalDisplayLabel,
  provisionalTitleFrame,
} from "../src/task-tree-provisional.ts";
import {
  applyLifecycleBoundary,
  armSession,
  classifyCliLifecycle,
  idleSession,
  markSessionCommitted,
  matchesOuterTerminal,
  openArmedSession,
  shouldFlushSessionOnDispose,
} from "../src/task-tree-session.ts";

const ts = "2026-05-19T12:00:00.000Z";
const ESC = String.fromCharCode(27);
const stripAnsi = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g"), "");

const cliInit = (commandId: string, invocationId: string, parentInvocationId?: string): LandoEvent =>
  Schema.decodeUnknownSync(CliCommandInitEvent)({
    _tag: `cli-${commandId}-init`,
    commandId,
    argv: [commandId],
    args: {},
    flags: {},
    cwd: "/tmp",
    invocationId,
    ...(parentInvocationId === undefined ? {} : { parentInvocationId }),
    timestamp: ts,
  });

const cliRun = (commandId: string, invocationId: string, parentInvocationId?: string): LandoEvent =>
  Schema.decodeUnknownSync(CliCommandRunEvent)({
    _tag: `cli-${commandId}-run`,
    commandId,
    argv: [commandId],
    args: {},
    flags: {},
    cwd: "/tmp",
    invocationId,
    ...(parentInvocationId === undefined ? {} : { parentInvocationId }),
    timestamp: ts,
    exitCode: 0,
    durationMs: 10,
  });

const cliError = (commandId: string, invocationId: string): LandoEvent =>
  Schema.decodeUnknownSync(CliCommandErrorEvent)({
    _tag: `cli-${commandId}-error`,
    commandId,
    argv: [commandId],
    args: {},
    flags: {},
    cwd: "/tmp",
    invocationId,
    timestamp: ts,
    exitCode: 1,
    durationMs: 10,
    failureTag: "Failure",
  });

describe("task-tree session classification", () => {
  test("classifies outer init, run, and error without treating task events as lifecycle", () => {
    expect(classifyCliLifecycle(cliInit("app:start", "inv-1"))).toEqual({
      kind: "init",
      commandId: "app:start",
      invocationId: "inv-1",
      nested: false,
    });
    expect(classifyCliLifecycle(cliRun("app:start", "inv-1"))?.kind).toBe("terminal");
    expect(classifyCliLifecycle(cliError("app:start", "inv-1"))?.kind).toBe("terminal");
    expect(classifyCliLifecycle({ _tag: "task.tree.start" } as LandoEvent)).toBeUndefined();
  });

  test("marks nested lifecycle when parentInvocationId is present", () => {
    expect(classifyCliLifecycle(cliInit("app:info", "inv-2", "inv-1"))?.nested).toBe(true);
  });
});

describe("task-tree session transitions", () => {
  test("arms only on outer init and ignores nested init", () => {
    const armed = armSession(idleSession(), cliInit("app:start", "inv-1"));
    expect(armed).toEqual({ kind: "armed", commandId: "app:start", invocationId: "inv-1" });
    expect(armSession(idleSession(), cliInit("app:info", "inv-2", "inv-1"))).toEqual(idleSession());
  });

  test("opens an armed session and matches only the same outer terminal", () => {
    const open = openArmedSession(armSession(idleSession(), cliInit("app:start", "inv-1")));
    expect(open.kind).toBe("open");
    expect(matchesOuterTerminal(open, cliRun("app:start", "inv-1"))).toBe(true);
    expect(matchesOuterTerminal(open, cliError("app:start", "inv-1"))).toBe(true);
    expect(matchesOuterTerminal(open, cliRun("app:start", "inv-other"))).toBe(false);
    expect(matchesOuterTerminal(open, cliRun("app:info", "inv-2", "inv-1"))).toBe(false);
  });

  test("flushes on dispose only when open, uncommitted, and a task exists", () => {
    const open = openArmedSession(armSession(idleSession(), cliInit("app:start", "inv-1")));
    expect(shouldFlushSessionOnDispose(open, true)).toBe(true);
    expect(shouldFlushSessionOnDispose(open, false)).toBe(false);
    expect(shouldFlushSessionOnDispose(markSessionCommitted(open), true)).toBe(false);
    expect(shouldFlushSessionOnDispose(armSession(idleSession(), cliInit("app:start", "inv-1")), true)).toBe(
      false,
    );
  });

  test("outer terminal without an open tree returns idle instead of commit", () => {
    const armed = armSession(idleSession(), cliInit("app:start", "inv-1"));
    expect(applyLifecycleBoundary(armed, cliRun("app:start", "inv-1"))).toEqual({
      action: "clear",
      session: idleSession(),
    });
    expect(applyLifecycleBoundary(armed, cliError("app:start", "inv-1"))).toEqual({
      action: "clear",
      session: idleSession(),
    });
  });

  test("open session still commits on a matching outer terminal", () => {
    const open = openArmedSession(armSession(idleSession(), cliInit("app:start", "inv-1")));
    expect(applyLifecycleBoundary(open, cliRun("app:start", "inv-1"))).toEqual({
      action: "commit",
      session: open,
    });
  });
});

describe("provisional startup title", () => {
  test("allowlists only the safe taskful command ids", () => {
    expect(isProvisionalStartupCommand("app:start")).toBe(true);
    expect(isProvisionalStartupCommand("app:restart")).toBe(true);
    expect(isProvisionalStartupCommand("app:rebuild")).toBe(true);
    expect(isProvisionalStartupCommand("apps:init")).toBe(false);
    expect(isProvisionalStartupCommand("meta:setup")).toBe(false);
    expect(isProvisionalStartupCommand("app:destroy")).toBe(false);
    expect(isProvisionalStartupCommand("mysql")).toBe(false);
    expect(isProvisionalStartupCommand("app:info")).toBe(false);
  });

  test("derives the display label from the canonical commandId namespace suffix", () => {
    expect(provisionalDisplayLabel("app:start")).toBe("start");
    expect(provisionalDisplayLabel("app:restart")).toBe("restart");
    expect(provisionalDisplayLabel("app:rebuild")).toBe("rebuild");
  });

  test("paints a styled title-only frame for the derived label", () => {
    const frame = provisionalTitleFrame("app:start");
    expect(frame).toHaveLength(1);
    expect(stripAnsi(frame[0] ?? "")).toBe("╭─ start");
    expect(frame[0]).toContain(ESC);
  });
});
