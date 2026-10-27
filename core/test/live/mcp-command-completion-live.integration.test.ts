import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CommandResultEnvelope } from "@lando/sdk/schema";
import { Schema } from "effect";
import { within } from "./mcp-cli-client.ts";
import { mcpAcceptanceBinary, mcpCompletionFixture, mcpPrerequisite } from "./mcp-completion-fixture.ts";

const enabled = mcpPrerequisite === undefined || process.env.LANDO_GUIDE_E2E === "1";
const suite = enabled ? describe.serial : describe.skip;
const decodeTool = Schema.decodeUnknownSync(
  Schema.Struct({
    result: Schema.Struct({
      isError: Schema.Boolean,
      structuredContent: CommandResultEnvelope,
    }),
  }),
);
const decodeExit = Schema.decodeUnknownSync(Schema.Struct({ exitCode: Schema.Number }));
const decodeEnvelope = Schema.decodeUnknownSync(Schema.fromJsonString(CommandResultEnvelope));

suite("compiled CLI managed MCP command completion", () => {
  let fixture: Awaited<ReturnType<typeof mcpCompletionFixture>> | undefined;
  const current = () => {
    if (fixture === undefined) throw new Error("MCP fixture has not started");
    return fixture;
  };
  beforeAll(async () => {
    if (mcpPrerequisite !== undefined) throw new Error(mcpPrerequisite);
    fixture = await mcpCompletionFixture();
    const started = await fixture.cli(["start", "--format=json"]);
    expect(started.exitCode, "Disposable MCP app failed to start").toBe(0);
  }, 180_000);
  afterAll(async () => {
    await fixture?.cleanup();
  }, 120_000);

  test.each([false, true])(
    "returns authoritative redacted output with progress=%s",
    async (progress) => {
      // Given: a compiled server executing real container tooling.
      const app = current();
      const client = app.client();
      try {
        await client.initialize();
        // When: the task writes split credentials, Unicode, stderr, and an unterminated final line.
        const response = await client.request("tools/call", {
          name: "app:stream",
          arguments: {},
          ...(progress ? { _meta: { progressToken: "stream" } } : {}),
        });
        await app.artifact("stream", response);
        const result = decodeTool(response).result;
        const output = result.structuredContent.output;
        // Then: the final result is useful regardless of notification subscription.
        expect(result.isError).toBe(false);
        expect(output?.truncated).toBe(false);
        expect(
          output?.chunks
            .filter((chunk) => chunk._tag === "stdout")
            .map((chunk) => chunk.chunk)
            .join(""),
        ).toBe("alpha\nsplit=[redacted]\nutf8=€\nlast-line");
        expect(
          output?.chunks
            .filter((chunk) => chunk._tag === "stderr")
            .map((chunk) => chunk.chunk)
            .join(""),
        ).toBe("stderr-line\n");
        expect(JSON.stringify(client.messages).includes(app.token)).toBe(false);
        expect(client.output("stream").length > 0).toBe(progress);
        expect(await client.close()).toBe(0);
      } finally {
        await client.dispose();
      }
    },
    60_000,
  );

  test("reports nonzero tooling completion without losing diagnostics", async () => {
    // Given: a real task that writes both streams before exiting 7.
    const app = current();
    const client = app.client();
    try {
      await client.initialize();
      // When: MCP executes that task without requesting progress.
      const response = await client.request("tools/call", { name: "app:fail", arguments: {} });
      await app.artifact("failed-tool", response);
      const result = decodeTool(response).result;
      // Then: status, typed exit code, and captured failure evidence agree.
      expect(result.isError).toBe(true);
      expect(result.structuredContent.ok).toBe(false);
      expect(decodeExit(result.structuredContent.result).exitCode).toBe(7);
      expect(result.structuredContent.error).toMatchObject({ _tag: "LandoCommandError", exitCode: 7 });
      const chunks = result.structuredContent.output?.chunks ?? [];
      expect(
        chunks
          .filter((chunk) => chunk._tag === "stdout")
          .map((chunk) => chunk.chunk)
          .join(""),
      ).toBe("before-failure");
      expect(
        chunks
          .filter((chunk) => chunk._tag === "stderr")
          .map((chunk) => chunk.chunk)
          .join(""),
      ).toBe("failure-diagnostic\n");
      expect((await client.request("tools/list")).result).toBeDefined();
      expect(await client.close()).toBe(0);
    } finally {
      await client.dispose();
    }
  }, 60_000);

  test("keeps CLI nonzero tooling status consistent with the machine result", async () => {
    // Given: the same process-backed task used by MCP.
    const app = current();
    // When: the compiled CLI runs it in JSON mode.
    const result = await app.cli(["fail", "--format=json"]);
    const envelope = decodeEnvelope(result.stdout);
    // Then: a failed child is not reported as a successful command.
    expect(result.exitCode).toBe(7);
    expect(envelope.ok).toBe(false);
    expect(decodeExit(envelope.result).exitCode).toBe(7);
    expect(envelope.error).toMatchObject({ _tag: "LandoCommandError", exitCode: 7 });
  }, 60_000);

  test.each([0, 7])(
    "executes exact container argv through MCP with exit %s",
    async (exitCode) => {
      // Given: an explicit exec argument vector with a space-bearing shell argument.
      const app = current();
      const client = app.client();
      try {
        await client.initialize();
        // When: the real built-in exec tool receives named arguments rather than CLI argv.
        const response = await client.request("tools/call", {
          name: "app:exec",
          arguments: {
            args: { command: ["app", "--", "sh", "-c", `printf 'exec proof'; exit ${exitCode}`] },
          },
        });
        await app.artifact("exec", response);
        const result = decodeTool(response).result;
        // Then: boundaries, completion status, and final output are preserved.
        expect(result.isError).toBe(exitCode !== 0);
        expect(result.structuredContent.ok).toBe(exitCode === 0);
        expect(decodeExit(result.structuredContent.result).exitCode).toBe(exitCode);
        expect(result.structuredContent.output?.chunks.map((chunk) => chunk.chunk).join("")).toBe(
          "exec proof",
        );
        expect(await client.close()).toBe(0);
      } finally {
        await client.dispose();
      }
    },
    60_000,
  );

  test("returns a bounded tail instead of buffering the whole command output", async () => {
    // Given: a task whose output exceeds the invocation capture budget.
    const app = current();
    const client = app.client();
    try {
      await client.initialize();
      // When: a client asks for its final result without live notifications.
      const response = await client.request("tools/call", { name: "app:large", arguments: {} });
      await app.artifact("bounded-output", response);
      const result = decodeTool(response).result;
      // Then: truncation is explicit and the useful end survives within the response bound.
      expect(result.isError).toBe(false);
      expect(result.structuredContent.output?.truncated).toBe(true);
      expect(
        result.structuredContent.output?.chunks
          .map((chunk) => chunk.chunk)
          .join("")
          .endsWith("tail-proof"),
      ).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(8 * 1024 * 1024);
      expect(await client.close()).toBe(0);
    } finally {
      await client.dispose();
    }
  }, 60_000);

  test.each(["SIGINT", "SIGTERM"] as const)(
    "releases a quiet CLI log follower on %s",
    async (signal) => {
      const app = current();
      const { BUN_BE_BUN: _bunBeBun, ...env } = process.env;
      const child = Bun.spawn(
        [mcpAcceptanceBinary, "logs", "--service=app", "--follow", "--tail=1", "--format=json"],
        { cwd: app.root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
      const diagnostics = new Response(child.stderr).text();
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      let stdout = "";
      try {
        while (!stdout.includes("quiet-ready")) {
          const next = await within(reader.read(), "initial CLI log record");
          if (next.done) throw new Error("CLI exited before its initial log record");
          stdout += decoder.decode(next.value, { stream: true });
        }
        const started = performance.now();
        child.kill(signal);
        const exitCode = await within(child.exited, "idle CLI shutdown", 5_000);
        const milliseconds = performance.now() - started;
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          stdout += decoder.decode(next.value, { stream: true });
        }
        const stderr = await diagnostics;
        await app.artifact("cli-idle-signal", { signal, exitCode, milliseconds, stdout, stderr });
        expect(exitCode).toBe(signal === "SIGINT" ? 130 : 143);
        expect(stderr).toBe("");
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
        await reader.cancel();
      }
    },
    60_000,
  );

  test.each(["cancel-and-eof", "eof", "SIGTERM"] as const)(
    "releases a quiet real log follower on %s",
    async (stop) => {
      // Given: a real provider log stream with one initial record and no future bytes.
      const app = current();
      const client = app.client();
      try {
        await client.initialize();
        const requestId = await client.beginFollow();
        await client.waitForOutput("follow", (chunk) => chunk.chunk.includes("quiet-ready"));
        // When: the client cancels or disconnects while the provider read is idle.
        const startedAt = performance.now();
        if (stop === "cancel-and-eof") {
          await client.cancel(requestId);
          await client.request("ping");
        }
        const exitCode = await client.close(stop === "SIGTERM" ? "SIGTERM" : undefined);
        const stderr = await client.diagnostics;
        await app.artifact("shutdown", {
          stop,
          exitCode,
          milliseconds: performance.now() - startedAt,
          messages: client.messages,
          stderr,
        });
        // Then: the process releases the read without needing another container log line.
        expect(exitCode).toBe(stop === "SIGTERM" ? 143 : 0);
        expect(stderr).toBe("");
        expect(client.messages.filter((message) => message.id === requestId)).toEqual([]);
      } finally {
        await client.dispose();
      }
    },
    60_000,
  );
});
