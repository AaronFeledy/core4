import { EventEmitter } from "node:events";

import { describe, expect, test } from "bun:test";

import {
  SIGINT_EXIT_CODE,
  SIGTERM_EXIT_CODE,
  runWithProcessSignalReraise,
} from "../../src/cli/process-signals.ts";

describe("CLI process signal re-raise", () => {
  test("removes the listener then re-raises on POSIX", async () => {
    // Given a POSIX host whose kill is captured.
    const events = new EventEmitter();
    const killed: Array<readonly [number, NodeJS.Signals]> = [];
    let exitCode: number | undefined;
    const during: { listeners: number } = { listeners: 0 };

    // When SIGINT arrives while the CLI body is still running.
    const result = await runWithProcessSignalReraise(
      async (state) => {
        during.listeners = events.listenerCount("SIGINT");
        events.emit("SIGINT");
        expect(state.received()).toBe("SIGINT");
        return "settled";
      },
      {
        platform: "linux",
        pid: 4242,
        events,
        signals: ["SIGINT", "SIGTERM"],
        kill: (pid, signal) => {
          killed.push([pid, signal]);
        },
        setExitCode: (code) => {
          exitCode = code;
        },
      },
    );

    // Then cleanup finished, the listener is gone, and the signal is re-raised.
    expect(result).toBe("settled");
    expect(during.listeners).toBe(1);
    expect(events.listenerCount("SIGINT")).toBe(0);
    expect(killed).toEqual([[4242, "SIGINT"]]);
    expect(exitCode).toBeUndefined();
  });

  test("re-raises SIGTERM on POSIX after the body settles", async () => {
    // Given a POSIX host.
    const events = new EventEmitter();
    const killed: NodeJS.Signals[] = [];

    // When SIGTERM arrives during the run.
    await runWithProcessSignalReraise(
      async () => {
        events.emit("SIGTERM");
      },
      {
        platform: "darwin",
        pid: 7,
        events,
        signals: ["SIGINT", "SIGTERM"],
        kill: (_pid, signal) => {
          killed.push(signal);
        },
      },
    );

    // Then SIGTERM is the re-raised signal.
    expect(killed).toEqual(["SIGTERM"]);
  });

  test("keeps exit 130 and 143 on win32 instead of re-raising", async () => {
    // Given a Windows host.
    const events = new EventEmitter();
    const killed: Array<readonly [number, NodeJS.Signals]> = [];
    let exitCode: number | undefined;

    // When SIGINT then a separate SIGTERM run complete.
    await runWithProcessSignalReraise(
      async () => {
        events.emit("SIGINT");
      },
      {
        platform: "win32",
        pid: 99,
        events,
        signals: ["SIGINT", "SIGTERM"],
        kill: (pid, signal) => {
          killed.push([pid, signal]);
        },
        setExitCode: (code) => {
          exitCode = code;
        },
      },
    );

    // Then the process keeps the bash-compatible code and does not kill itself.
    expect(killed).toEqual([]);
    expect(exitCode).toBe(SIGINT_EXIT_CODE);

    let termCode: number | undefined;
    await runWithProcessSignalReraise(
      async () => {
        events.emit("SIGTERM");
      },
      {
        platform: "win32",
        pid: 99,
        events,
        signals: ["SIGINT", "SIGTERM"],
        kill: (pid, signal) => {
          killed.push([pid, signal]);
        },
        setExitCode: (code) => {
          termCode = code;
        },
      },
    );
    expect(killed).toEqual([]);
    expect(termCode).toBe(SIGTERM_EXIT_CODE);
  });

  test("does not register SIGHUP when neither stdio stream is a TTY", async () => {
    // Given a POSIX host with no TTY.
    const events = new EventEmitter();

    // When the default signal set is installed.
    await runWithProcessSignalReraise(
      async () => {
        expect(events.listenerCount("SIGHUP")).toBe(0);
        expect(events.listenerCount("SIGINT")).toBe(1);
        expect(events.listenerCount("SIGTERM")).toBe(1);
      },
      {
        platform: "linux",
        events,
        stdinIsTTY: false,
        stdoutIsTTY: false,
        sigIgn: 0n,
        kill: () => {
          throw new Error("kill must not run");
        },
      },
    );
  });

  test("does not register SIGHUP when SigIgn bit 0 is set", async () => {
    // Given a TTY that inherited hangup ignore, as nohup does.
    const events = new EventEmitter();

    // When the default signal set is installed.
    await runWithProcessSignalReraise(
      async () => {
        expect(events.listenerCount("SIGHUP")).toBe(0);
        expect(events.listenerCount("SIGINT")).toBe(1);
      },
      {
        platform: "linux",
        events,
        stdinIsTTY: true,
        stdoutIsTTY: true,
        sigIgn: 1n,
        kill: () => {
          throw new Error("kill must not run");
        },
      },
    );
  });

  test("does not register SIGINT when SigIgn bit 1 is set", async () => {
    // Given a background job that inherited SIGINT ignore.
    const events = new EventEmitter();

    // When the default signal set is installed.
    await runWithProcessSignalReraise(
      async () => {
        expect(events.listenerCount("SIGINT")).toBe(0);
        expect(events.listenerCount("SIGTERM")).toBe(1);
      },
      {
        platform: "linux",
        events,
        stdinIsTTY: true,
        stdoutIsTTY: true,
        sigIgn: 2n,
        kill: () => {
          throw new Error("kill must not run");
        },
      },
    );
  });

  test("does not re-raise when no signal arrived", async () => {
    // Given a POSIX host that runs to completion.
    const events = new EventEmitter();
    const killed: NodeJS.Signals[] = [];

    // When the body returns without an interrupt.
    const result = await runWithProcessSignalReraise(async () => "ok", {
      platform: "linux",
      events,
      signals: ["SIGINT", "SIGTERM"],
      kill: (_pid, signal) => {
        killed.push(signal);
      },
    });

    // Then listeners are removed and kill is not called.
    expect(result).toBe("ok");
    expect(killed).toEqual([]);
    expect(events.listenerCount("SIGINT")).toBe(0);
  });
});
