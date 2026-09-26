import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { type Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessRunner } from "@lando/sdk/services";
import { Effect, Either } from "effect";
import {
  type GpgAgentDiscoveryOptions,
  discoverHostGpgAgent,
} from "../../../src/subsystems/gpg-agent/discovery.ts";

const recordingRunner = (calls: ReadonlyArray<string>[], stdout = "/extra\n") =>
  ({
    run: ({ args }) => {
      calls.push(args);
      return Effect.succeed({ exitCode: 0, stdout, stderr: "" });
    },
  }) satisfies Pick<ProcessRunner["Type"], "run">;
const restricted: Pick<GpgAgentDiscoveryOptions, "inspectPath" | "probeRestricted"> = {
  inspectPath: async () => "socket",
  probeRestricted: async () => "restricted",
};
const fakeAgent = (reply: string) =>
  createServer((socket) => {
    socket.write("OK Pleased to meet you\n");
    socket.once("data", () => socket.write(reply));
  });
const listen = (server: Server, path: string) => new Promise<void>((resolve) => server.listen(path, resolve));
const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

test("prefers an explicit socket without invoking gpgconf", async () => {
  // Given
  const calls: ReadonlyArray<string>[] = [];
  // When
  const result = await Effect.runPromise(
    discoverHostGpgAgent({
      runner: recordingRunner(calls, "/other"),
      explicitSocket: "/explicit",
      launch: true,
      ...restricted,
    }),
  );
  // Then
  expect(result).toEqual({ _tag: "unix", path: "/explicit", source: "explicit" });
  expect(calls).toEqual([]);
});

test("reports gpg-missing when gpgconf is unavailable", async () => {
  // Given
  const runner: Pick<ProcessRunner["Type"], "run"> = {
    run: () => Effect.succeed({ exitCode: 127, stdout: "", stderr: "" }),
  };
  // When
  const result = await Effect.runPromise(
    Effect.either(discoverHostGpgAgent({ runner, launch: true, ...restricted })),
  );
  // Then
  expect(result).toMatchObject({
    _tag: "Left",
    left: { _tag: "GpgAgentUnavailableError", reason: "gpg-missing" },
  });
});

test("launches once then fails socket-missing when the socket remains absent", async () => {
  // Given
  const calls: ReadonlyArray<string>[] = [];
  // When
  const result = await Effect.runPromise(
    Effect.either(
      discoverHostGpgAgent({
        runner: recordingRunner(calls),
        launch: true,
        inspectPath: async () => "missing",
        probeRestricted: async () => "restricted",
      }),
    ),
  );
  // Then
  expect(result).toMatchObject({ _tag: "Left", left: { reason: "socket-missing" } });
  expect(calls).toEqual([
    ["--list-dirs", "agent-extra-socket"],
    ["--launch", "gpg-agent"],
  ]);
});

test("never launches gpg-agent when launch is false", async () => {
  // Given
  const calls: ReadonlyArray<string>[] = [];
  // When
  const result = await Effect.runPromise(
    Effect.either(
      discoverHostGpgAgent({
        runner: recordingRunner(calls),
        launch: false,
        inspectPath: async () => "missing",
        probeRestricted: async () => "restricted",
      }),
    ),
  );
  // Then
  expect(result).toMatchObject({ _tag: "Left", left: { reason: "socket-missing", socketPath: "/extra" } });
  expect(calls).toEqual([["--list-dirs", "agent-extra-socket"]]);
});

test("rejects a symlink or regular file at the socket path without launching", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "gpg-discovery-"));
  const regular = join(root, "regular");
  const link = join(root, "link");
  await writeFile(regular, "");
  await symlink(regular, link);
  const calls: ReadonlyArray<string>[] = [];
  try {
    for (const path of [regular, link]) {
      // When
      const result = await Effect.runPromise(
        Effect.either(
          discoverHostGpgAgent({
            runner: recordingRunner(calls),
            explicitSocket: path,
            launch: true,
            probeRestricted: async () => "restricted",
          }),
        ),
      );
      // Then
      expect(result).toMatchObject({
        _tag: "Left",
        left: {
          _tag: "GpgAgentUnavailableError",
          reason: "socket-missing",
          socketPath: path,
          remediation: expect.stringMatching(/agent-extra-socket/),
        },
      });
    }
    expect(calls).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  ["explicit", "ERR 67108987 False <GPG Agent>\n", { reason: "unrestricted-socket" }],
  ["gpgconf", "OK\n", undefined],
] as const)("probes the %s socket with GETINFO restricted", async (source, reply, failure) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "gpg-discovery-"));
  const path = join(root, "S.gpg-agent.extra");
  const server = fakeAgent(reply);
  await listen(server, path);
  const calls: ReadonlyArray<string>[] = [];
  try {
    // When
    const result = await Effect.runPromise(
      Effect.either(
        discoverHostGpgAgent({
          runner: recordingRunner(calls, `${path}\n`),
          launch: true,
          ...(source === "explicit" ? { explicitSocket: path } : {}),
        }),
      ),
    );
    // Then
    if (failure === undefined) {
      expect(Either.isRight(result) ? result.right : result).toEqual({ _tag: "unix", path, source });
    } else {
      expect(result).toMatchObject({
        _tag: "Left",
        left: {
          _tag: "GpgAgentUnavailableError",
          ...failure,
          socketPath: path,
          remediation: expect.stringMatching(/agent-extra-socket/),
        },
      });
    }
    expect(calls.some((args) => args.includes("--launch"))).toBe(false);
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("a socket nobody answers fails socket-missing", async () => {
  // Given
  const calls: ReadonlyArray<string>[] = [];
  // When
  const result = await Effect.runPromise(
    Effect.either(
      discoverHostGpgAgent({
        runner: recordingRunner(calls),
        launch: true,
        inspectPath: async () => "socket",
        probeRestricted: async () => {
          throw new Error("connection refused");
        },
      }),
    ),
  );
  // Then
  expect(result).toMatchObject({ _tag: "Left", left: { reason: "socket-missing", socketPath: "/extra" } });
  expect(JSON.stringify(result)).not.toContain("connection refused");
});
