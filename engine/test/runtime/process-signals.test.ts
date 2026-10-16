import { describe, expect, test } from "bun:test";

import {
  defaultInterruptSignals,
  isInheritedSignalIgnored,
  parseSigIgnMask,
  shouldHandleSIGHUP,
  shouldHandleSIGINT,
} from "../../src/runtime/process-signals.ts";

const statusWithSigIgn = (mask: string): string =>
  ["Name:\tlando", "State:\tR (running)", `SigIgn:\t${mask}`, "SigCgt:\t0000000000000000"].join("\n");

describe("process signal policy", () => {
  test("parses SigIgn and treats bit 0 as hangup, bit 1 as interrupt", () => {
    // Given a Linux /proc/self/status block with HUP and INT ignored.
    const sigIgn = parseSigIgnMask(statusWithSigIgn("0000000000000003"));

    // When those bits are tested.
    // Then HUP (bit 0) and INT (bit 1) are ignored, TERM is not.
    expect(sigIgn).toBe(3n);
    expect(isInheritedSignalIgnored(1, sigIgn)).toBe(true);
    expect(isInheritedSignalIgnored(2, sigIgn)).toBe(true);
    expect(isInheritedSignalIgnored(15, sigIgn)).toBe(false);
    expect(parseSigIgnMask("Name:\tlando\n")).toBeUndefined();
  });

  test("installs SIGHUP only for a TTY that did not inherit ignore", () => {
    // Given a hangup policy matrix.
    // When each host shape is classified.
    // Then a TTY without SigIgn handles HUP, and nohup / ignored HUP do not.
    expect(shouldHandleSIGHUP({ stdinIsTTY: true, stdoutIsTTY: false })).toBe(true);
    expect(shouldHandleSIGHUP({ stdinIsTTY: false, stdoutIsTTY: true })).toBe(true);
    expect(shouldHandleSIGHUP({ stdinIsTTY: false, stdoutIsTTY: false })).toBe(false);
    expect(shouldHandleSIGHUP({ stdinIsTTY: true, stdoutIsTTY: true, sigIgn: 1n })).toBe(false);
    expect(shouldHandleSIGHUP({ stdinIsTTY: true, stdoutIsTTY: true, sigIgn: 2n })).toBe(true);
  });

  test("skips SIGINT when the inherited mask ignores it", () => {
    // Given background-job vs foreground SigIgn masks.
    // When SIGINT is classified.
    // Then only the inherited-ignore case is skipped.
    expect(shouldHandleSIGINT({})).toBe(true);
    expect(shouldHandleSIGINT({ sigIgn: 0n })).toBe(true);
    expect(shouldHandleSIGINT({ sigIgn: 2n })).toBe(false);
    expect(shouldHandleSIGINT({ sigIgn: 1n })).toBe(true);
  });

  test("default POSIX set drops HUP without a TTY and INT when ignored", () => {
    // Given injected host facts, not the ambient process TTY.
    // When the default set is computed.
    // Then win32 keeps BREAK, POSIX gates HUP and INT, and TERM remains.
    expect(defaultInterruptSignals("win32")).toEqual(["SIGINT", "SIGTERM", "SIGBREAK"]);
    expect(
      defaultInterruptSignals("linux", { stdinIsTTY: true, stdoutIsTTY: true, sigIgn: 0n }),
    ).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);
    expect(
      defaultInterruptSignals("linux", { stdinIsTTY: false, stdoutIsTTY: false, sigIgn: 0n }),
    ).toEqual(["SIGINT", "SIGTERM"]);
    expect(
      defaultInterruptSignals("linux", { stdinIsTTY: true, stdoutIsTTY: true, sigIgn: 1n }),
    ).toEqual(["SIGINT", "SIGTERM"]);
    expect(
      defaultInterruptSignals("linux", { stdinIsTTY: true, stdoutIsTTY: true, sigIgn: 2n }),
    ).toEqual(["SIGTERM", "SIGHUP"]);
    expect(
      defaultInterruptSignals("darwin", { stdinIsTTY: false, stdoutIsTTY: false }),
    ).toEqual(["SIGINT", "SIGTERM"]);
    expect(
      defaultInterruptSignals({
        platform: "linux",
        stdinIsTTY: true,
        stdoutIsTTY: false,
        readStatus: () => statusWithSigIgn("0000000000000001"),
      }),
    ).toEqual(["SIGINT", "SIGTERM"]);
  });
});
