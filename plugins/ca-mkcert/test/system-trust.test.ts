import { describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessExecError } from "@lando/sdk/errors";
import type { ProcessResult } from "@lando/sdk/services";
import { TEST_CERTIFICATES } from "@lando/sdk/test";
import { Effect, Stream } from "effect";

import { makeSystemTrust } from "../src/system-trust.ts";

const { rootA, rootB } = TEST_CERTIFICATES;
const INSTALL = "Run `lando setup` without `--skip-install-ca`.";
const SPAWN_FAILED = new ProcessExecError({
  message: "spawn ENOENT",
  cmd: "probe",
  remediation: "Install it.",
});

/** A runner that answers each probe with the next exit code, or fails to spawn on `"spawn-failed"`. */
const fakeRunner = (answers: ReadonlyArray<number | "spawn-failed">) => {
  const calls: Array<{ readonly cmd: string; readonly args: ReadonlyArray<string> }> = [];
  return {
    calls,
    service: {
      run: (input: { readonly cmd: string; readonly args: ReadonlyArray<string> }) => {
        const answer = answers[calls.length];
        calls.push({ cmd: input.cmd, args: [...input.args] });
        if (answer === "spawn-failed") return Effect.fail(SPAWN_FAILED);
        return Effect.succeed<ProcessResult>({ exitCode: answer ?? 0, stdout: "", stderr: "not trusted" });
      },
      stream: () => Stream.die(new Error("unused")),
      streamWithExit: () => Stream.die(new Error("unused")),
    },
  };
};

const inspect = (
  platform: string,
  runner: ReturnType<typeof fakeRunner>,
  linuxBundles?: ReadonlyArray<string>,
) =>
  Effect.runPromise(
    makeSystemTrust({ processRunner: runner.service, platform, linuxBundles }).inspect("/caroot", rootA),
  );

describe("fresh system trust store check", () => {
  test("linux reads the first readable distro bundle and matches the root by fingerprint", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-system-trust-"));
    try {
      // Given: the first candidate is missing, the second holds the root, the third does not
      const missing = join(dir, "missing.pem");
      const holds = join(dir, "holds.pem");
      const lacks = join(dir, "lacks.pem");
      await writeFile(holds, `${rootB}\n${rootA}`);
      await writeFile(lacks, rootB);
      const runner = fakeRunner([]);
      // When
      const trusted = await inspect("linux", runner, [missing, holds, lacks]);
      const untrusted = await inspect("linux", runner, [lacks, holds]);
      const unreadable = await inspect("linux", runner, [missing]);
      // Then
      expect(trusted).toEqual({
        id: "system",
        name: "System trust store",
        location: holds,
        state: "trusted",
      });
      expect(untrusted).toEqual({
        id: "system",
        name: "System trust store",
        location: lacks,
        state: "untrusted",
        reason: "missing",
        detail: "The bundle does not include the local CA.",
        remediation: INSTALL,
      });
      expect(unreadable).toMatchObject({
        state: "unknown",
        reason: "inspection-failed",
        remediation: INSTALL,
      });
      expect(unreadable.detail).toContain(missing);
      expect(runner.calls).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test.each([
    { answer: 0, state: "trusted", reason: undefined },
    { answer: 1, state: "untrusted", reason: "missing" },
    { answer: "spawn-failed", state: "unknown", reason: "inspection-failed" },
  ] as const)("darwin maps `security verify-cert` $answer to $state", async ({ answer, state, reason }) => {
    const runner = fakeRunner([answer]);
    const status = await inspect("darwin", runner);
    expect(runner.calls).toEqual([
      {
        cmd: "/usr/bin/security",
        args: ["verify-cert", "-l", "-L", "-R", "offline", "-p", "ssl", "-c", "/caroot/rootCA.pem"],
      },
    ]);
    expect(status).toMatchObject({ id: "system", name: "macOS keychain", state });
    expect(status.reason).toBe(reason);
  });

  test.each([
    { answers: [0], state: "trusted", probes: 1 },
    { answers: [1, 0], state: "trusted", probes: 2 },
    { answers: [1, 1], state: "untrusted", probes: 2 },
    { answers: ["spawn-failed"], state: "unknown", probes: 1 },
  ] as const)(
    "win32 checks the user then the machine Root store ($answers -> $state)",
    async ({ answers, state, probes }) => {
      const sha1 = new X509Certificate(rootA).fingerprint.replaceAll(":", "");
      const runner = fakeRunner(answers);
      const status = await inspect("win32", runner);
      expect(runner.calls).toEqual(
        [
          { cmd: "certutil", args: ["-user", "-store", "Root", sha1] },
          { cmd: "certutil", args: ["-store", "Root", sha1] },
        ].slice(0, probes),
      );
      expect(status).toMatchObject({ id: "system", name: "Windows certificate store", state });
    },
  );
});
