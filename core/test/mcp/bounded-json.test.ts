import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { McpTransportError } from "@lando/sdk/errors";
import { createRedactor } from "@lando/sdk/secrets";

import { redactBoundedJsonValue, stringifyBoundedJson } from "../../src/mcp/bounded-json.ts";
import { MAX_OUTBOUND_QUEUED_BYTES } from "../../src/mcp/stdio-limits.ts";

describe("bounded MCP JSON", () => {
  test("matches native JSON string semantics for astral and surrogate strings", async () => {
    // Given
    const value = {
      astral: "before 😀 𝄞 after",
      loneHigh: "\ud800",
      loneLow: "\udfff",
      escaped: 'quote " slash \\ controls \b\t\n\f\r\u0000',
    };

    // When
    const encoded = await Effect.runPromise(stringifyBoundedJson(value, "test payload"));

    // Then
    expect(encoded).toBe(JSON.stringify(value));
  });

  test("rejects accessors and toJSON without executing them", async () => {
    // Given
    let getterCalls = 0;
    let toJsonCalls = 0;
    const accessor = {
      get value(): string {
        getterCalls += 1;
        return "not-read";
      },
    };
    const customJson = {
      toJSON: () => {
        toJsonCalls += 1;
        return { leaked: true };
      },
    };

    // When
    const accessorExit = await Effect.runPromiseExit(stringifyBoundedJson(accessor, "accessor payload"));
    const toJsonExit = await Effect.runPromiseExit(stringifyBoundedJson(customJson, "toJSON payload"));

    // Then
    expect(accessorExit._tag).toBe("Failure");
    expect(toJsonExit._tag).toBe("Failure");
    expect(getterCalls).toBe(0);
    expect(toJsonCalls).toBe(0);
  });

  test("enforces the aggregate retained serialization budget", async () => {
    // Given
    let trailingGetterCalls = 0;
    const value = {
      chunks: Array.from({ length: 9 }, () => "x".repeat(1_000_000)),
      get trailing(): string {
        trailingGetterCalls += 1;
        return "not-read";
      },
    };

    // When
    const exit = await Effect.runPromiseExit(stringifyBoundedJson(value, "aggregate payload"));

    // Then
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(McpTransportError);
      expect(exit.cause.error.message).toContain("8 MiB");
    }
    expect(trailingGetterCalls).toBe(0);
  });

  test("redacts secret keys and values before returning serialized data", async () => {
    // Given
    const secret = "known-secret-material";
    const redactor = createRedactor("secrets", { values: [secret] });
    const value = {
      [secret]: "ordinary-value",
      apiToken: "different-secret",
      message: `value=${secret}`,
    };

    // When
    const redacted = await Effect.runPromise(redactBoundedJsonValue(value, redactor, "secret payload"));
    const encoded = JSON.stringify(redacted);

    // Then
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThan(MAX_OUTBOUND_QUEUED_BYTES);
    expect(encoded).toContain("[redacted]");
    expect(encoded).not.toContain(secret);
    expect(encoded).not.toContain("different-secret");
  });

  test("charges omitted properties against the aggregate traversal budget", async () => {
    // Given
    const omittedKey = "x".repeat(MAX_OUTBOUND_QUEUED_BYTES + 1);
    const value = { [omittedKey]: undefined };

    // When
    const exit = await Effect.runPromiseExit(stringifyBoundedJson(value, "omitted property payload"));

    // Then
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(McpTransportError);
      expect(exit.cause.error.message).toContain("8 MiB");
    }
  });

  test("uses bounded canonical redaction instead of retaining expanded legacy output", async () => {
    // Given
    const canonical = createRedactor("secrets", { values: ["a"] });
    let legacyCalls = 0;
    const redactor = {
      ...canonical,
      redactString: (text: string) => {
        legacyCalls += 1;
        return canonical.redactString(text);
      },
    };

    // When
    const exit = await Effect.runPromiseExit(
      stringifyBoundedJson("a".repeat(900_000), "expanded secret payload", redactor),
    );

    // Then
    expect(exit._tag).toBe("Failure");
    expect(legacyCalls).toBe(0);
  });

  test("rejects object and array proxies without invoking traps", async () => {
    // Given
    let trapCalls = 0;
    const traps: ProxyHandler<object> = {
      get: () => {
        trapCalls += 1;
        return undefined;
      },
      getOwnPropertyDescriptor: () => {
        trapCalls += 1;
        return undefined;
      },
      getPrototypeOf: () => {
        trapCalls += 1;
        return null;
      },
      ownKeys: () => {
        trapCalls += 1;
        return [];
      },
    };
    const objectProxy = new Proxy({}, traps);
    const arrayProxy = new Proxy([], traps);

    // When
    const objectExit = await Effect.runPromiseExit(stringifyBoundedJson(objectProxy, "object proxy"));
    const arrayExit = await Effect.runPromiseExit(stringifyBoundedJson(arrayProxy, "array proxy"));

    // Then
    expect(objectExit._tag).toBe("Failure");
    expect(arrayExit._tag).toBe("Failure");
    expect(trapCalls).toBe(0);
  });

  test("rejects arrays with custom prototypes without invoking inherited toJSON", async () => {
    // Given
    let toJsonCalls = 0;
    const value = ["safe"];
    Object.setPrototypeOf(value, {
      ...Array.prototype,
      toJSON: () => {
        toJsonCalls += 1;
        return ["unsafe"];
      },
    });

    // When
    const exit = await Effect.runPromiseExit(stringifyBoundedJson(value, "custom array"));

    // Then
    expect(exit._tag).toBe("Failure");
    expect(toJsonCalls).toBe(0);
  });

  test("does not reserve the full serialization budget for a small payload", async () => {
    // Given
    const fixture = new URL("./fixtures/bounded-json-memory.ts", import.meta.url);

    // When
    const child = Bun.spawn({ cmd: [process.execPath, fixture.pathname], stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    // Then
    expect(exitCode, stderr).toBe(0);
    const result: unknown = JSON.parse(stdout);
    expect(result).toEqual({ encoded: '{"ok":true}', retainedArrayBufferBytes: expect.any(Number) });
    if (
      result === null ||
      typeof result !== "object" ||
      !("retainedArrayBufferBytes" in result) ||
      typeof result.retainedArrayBufferBytes !== "number"
    ) {
      throw new Error("memory fixture returned an invalid result");
    }
    expect(result.retainedArrayBufferBytes).toBeLessThan(1 * 1_024 * 1_024);
  });
});
