import { describe, expect, test } from "bun:test";
import { DebuggerConfig, DebuggerHost, GlobalConfig, GlobalConfigView } from "@lando/sdk/schema";
import { Result, Schema } from "effect";

const decodeConfig = Schema.decodeUnknownResult(GlobalConfig, { onExcessProperty: "error" });
const decodeHost = Schema.decodeUnknownResult(DebuggerHost, { onExcessProperty: "error" });
const decodeDebugger = Schema.decodeUnknownResult(DebuggerConfig, { onExcessProperty: "error" });

describe("GlobalConfig.debugger", () => {
  test("leaves debugger undefined when omitted", () => {
    // Given / When
    const decoded = Schema.decodeUnknownSync(GlobalConfig)({});
    // Then
    expect(decoded.debugger).toBeUndefined();
  });

  test("accepts windows and specific IP literals", () => {
    // Given / When / Then
    for (const host of ["windows", "192.0.2.40", "2001:db8::40", "127.0.0.1"] as const) {
      const result = decodeConfig({ debugger: { host } });
      expect(Result.isSuccess(result)).toBe(true);
      if (Result.isSuccess(result)) expect(result.success.debugger?.host).toBe(host);
    }
  });

  test("accepts an empty debugger object with host omitted", () => {
    // Given / When
    const result = decodeDebugger({});
    // Then
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) expect(result.success.host).toBeUndefined();
  });

  test.each([
    "0.0.0.0",
    "::",
    "::0",
    "0:0:0:0:0:0:0:0",
    "0000:0000:0000:0000:0000:0000:0000:0000",
    "::0.0.0.0",
  ])("rejects unspecified debugger host %j", (host) => {
    // Given / When
    const hostResult = decodeHost(host);
    const configResult = decodeConfig({ debugger: { host } });
    // Then
    expect(Result.isFailure(hostResult)).toBe(true);
    expect(Result.isFailure(configResult)).toBe(true);
  });

  test.each(["hostname.example", "host-gateway", "localhost", ""])(
    "rejects non-address debugger host %j",
    (host) => {
      // Given / When
      const result = decodeConfig({ debugger: { host } });
      // Then
      expect(Result.isFailure(result)).toBe(true);
    },
  );

  test("GlobalConfigView keeps debugger", () => {
    // Given
    const input = { debugger: { host: "windows" as const } };
    // When
    const loaded = Schema.decodeUnknownSync(GlobalConfig)(input, { onExcessProperty: "error" });
    const view = Schema.encodeSync(GlobalConfigView)(loaded);
    // Then
    expect(loaded).toMatchObject(input);
    expect(view).toMatchObject(input);
  });

  test("decode(encode(decode(x))) is stable under onExcessProperty error", () => {
    // Given
    const inputs = [
      {},
      { debugger: {} },
      { debugger: { host: "windows" } },
      { debugger: { host: "192.0.2.40" } },
      { debugger: { host: "2001:db8::40" } },
    ] as const;
    const decode = Schema.decodeUnknownSync(GlobalConfig, { onExcessProperty: "error" });
    const encode = Schema.encodeSync(GlobalConfig);
    // When / Then
    for (const input of inputs) {
      const once = decode(input);
      const roundTrip = decode(encode(once));
      expect(roundTrip.debugger).toEqual(once.debugger);
    }
  });
});
