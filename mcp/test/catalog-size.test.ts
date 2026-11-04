import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCommandResultEnvelope } from "@lando/sdk/command-result";
import { LandofileValidationError } from "@lando/sdk/errors";
import { createRedactor } from "@lando/sdk/secrets";
import { Effect, Schema } from "effect";
import { conforms } from "./schema-conformance";

const response = Schema.decodeUnknownSync(
  Schema.Struct({
    id: Schema.Number,
    result: Schema.JsonObject,
  }),
);

test("keeps the real default tools/list within discovery budgets and accepts doctor envelopes", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-mcp-catalog-"));
  const child = Bun.spawn([process.execPath, "core/bin/lando.ts", "mcp"], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    env: {
      ...process.env,
      LANDO_USER_DATA_ROOT: join(root, "data"),
      LANDO_USER_CONF_ROOT: join(root, "conf"),
      LANDO_USER_CACHE_ROOT: join(root, "cache"),
      LANDO_PROVIDER: "podman",
      PATH: "/no-such-path",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 25_000);
  const send = (message: Schema.JsonObject) => child.stdin.write(`${JSON.stringify(message)}\n`);
  let catalog: Schema.JsonObject | undefined;
  let doctor: Schema.JsonObject | undefined;
  const decoder = new TextDecoder();
  let pending = "";
  // When
  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "catalog-budget", version: "1" },
      },
    });
    for await (const chunk of child.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const frame = Schema.decodeUnknownSync(Schema.JsonObject)(JSON.parse(pending.slice(0, newline)));
        pending = pending.slice(newline + 1);
        if (typeof frame.id !== "number") {
          newline = pending.indexOf("\n");
          continue;
        }
        const message = response(frame);
        if (message.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        } else if (message.id === 2) {
          catalog = message.result;
          send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "meta:doctor" } });
        } else if (message.id === 3) {
          doctor = message.result;
          child.stdin.end();
        }
        newline = pending.indexOf("\n");
      }
    }
    const exit = await child.exited;
    expect(await new Response(child.stderr).text()).toBe("");
    expect(exit).toBe(0);
  } finally {
    clearTimeout(timeout);
    child.kill();
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
  // Then
  const tools = Schema.decodeUnknownSync(
    Schema.Array(Schema.Struct({ name: Schema.String, outputSchema: Schema.JsonObject })),
  )(catalog?.tools);
  // Built-in defaults plus the bundled @lando/sql db:snapshots tool.
  expect(tools).toHaveLength(16);
  expect(tools.map((tool) => tool.name)).toContain("db:snapshots");
  expect(Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: 2, result: catalog }))).toBeLessThan(85_000);
  for (const tool of tools) {
    expect(Buffer.byteLength(JSON.stringify(tool.outputSchema)), tool.name).toBeLessThan(9_000);
  }
  const doctorSchema = tools.find((tool) => tool.name === "meta:doctor")?.outputSchema;
  const envelope = Schema.decodeUnknownSync(Schema.JsonObject)(doctor?.structuredContent);
  expect(envelope.ok).toBe(true);
  expect(envelope.result).toBeDefined();
  expect(doctorSchema).toBeDefined();
  if (doctorSchema === undefined) throw new TypeError("Missing doctor schema");
  expect(conforms(doctorSchema, envelope)).toBe(true);
  const error = new LandofileValidationError({
    file: ".lando.yml",
    message: "Invalid input",
    remediation: "Fix input",
    issues: [{ path: ["services", "web"], message: "Unknown service" }],
  });
  for (const partial of [false, true]) {
    const encoded = await Effect.runPromise(
      buildCommandResultEnvelope({
        command: "meta:doctor",
        resultSchema: Schema.Unknown,
        redactor: createRedactor("secrets"),
        outcome: {
          _tag: "failure",
          error,
          additionalErrors: [],
          ...(partial ? { value: envelope.result } : {}),
        },
        output: { chunks: [{ _tag: "stderr", chunk: "diagnostic tail" }], truncated: true },
      }),
    );
    expect(conforms(doctorSchema, Schema.decodeUnknownSync(Schema.Json)(encoded))).toBe(true);
    expect(encoded.error?.issues).toEqual(error.issues);
    if (partial) expect(encoded.result).toEqual(envelope.result);
  }
}, 30_000);
