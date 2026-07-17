import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import {
  HOST_PROXY_REQUEST_TAGS,
  HostProxyErrorCode,
  HostProxyRequest,
  HostProxyResponse,
} from "../../src/schema/host-proxy.ts";

describe("HostProxyRequest", () => {
  test("decodes a runLando request", () => {
    const value = Schema.decodeUnknownSync(HostProxyRequest)({
      _tag: "runLando",
      argv: ["open", "--print"],
      cwd: "/app",
      tty: false,
    });
    expect(value._tag).toBe("runLando");
    if (value._tag === "runLando") {
      expect(value.argv).toEqual(["open", "--print"]);
      expect(value.cwd).toBe("/app");
      expect(value.tty).toBe(false);
    }
  });

  test("decodes a runLando request with filtered env", () => {
    const value = Schema.decodeUnknownSync(HostProxyRequest)({
      _tag: "runLando",
      argv: ["open"],
      cwd: "/app",
      tty: true,
      env: { LANDO_APP: "demo", LANG: "en_US.UTF-8" },
    });
    if (value._tag !== "runLando") throw new Error("expected runLando");
    expect(value.env).toEqual({ LANDO_APP: "demo", LANG: "en_US.UTF-8" });
  });

  test("decodes an openUrl request (forward-compat variant)", () => {
    const value = Schema.decodeUnknownSync(HostProxyRequest)({
      _tag: "openUrl",
      url: "https://demo.lndo.site",
    });
    expect(value._tag).toBe("openUrl");
  });

  test("rejects an unknown request tag", () => {
    expect(() => Schema.decodeUnknownSync(HostProxyRequest)({ _tag: "bogus", argv: [] })).toThrow();
  });

  test("rejects deleted notify and clipboardCopy variants", () => {
    expect(() => Schema.decodeUnknownSync(HostProxyRequest)({ _tag: "notify", title: "done" })).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(HostProxyRequest)({ _tag: "clipboardCopy", text: "secret" }),
    ).toThrow();
  });

  test("union membership is exactly openUrl, openPath, runLando, runBun", () => {
    expect([...HOST_PROXY_REQUEST_TAGS].sort()).toEqual(["openPath", "openUrl", "runBun", "runLando"].sort());
  });

  test("rejects a runLando request missing cwd", () => {
    expect(() =>
      Schema.decodeUnknownSync(HostProxyRequest)({ _tag: "runLando", argv: ["open"], tty: false }),
    ).toThrow();
  });
});

describe("HostProxyResponse", () => {
  test("decodes an ok response", () => {
    const value = Schema.decodeUnknownSync(HostProxyResponse)({ _tag: "ok" });
    expect(value._tag).toBe("ok");
  });

  test("decodes an error response with a valid error code", () => {
    const value = Schema.decodeUnknownSync(HostProxyResponse)({
      _tag: "error",
      code: "command-not-allowed",
      message: "not allowed",
      remediation: "add to allowlist",
    });
    if (value._tag !== "error") throw new Error("expected error");
    expect(value.code).toBe("command-not-allowed");
    expect(value.message).toBe("not allowed");
  });

  test("rejects an error response with an unknown error code", () => {
    expect(() =>
      Schema.decodeUnknownSync(HostProxyResponse)({
        _tag: "error",
        code: "not-a-real-code",
        message: "x",
      }),
    ).toThrow();
  });
});

describe("HostProxyErrorCode", () => {
  test("accepts the documented codes", () => {
    for (const code of ["command-not-allowed", "allowlist-conflict", "scheme-not-allowed"]) {
      expect(Schema.decodeUnknownSync(HostProxyErrorCode)(code)).toBe(code);
    }
  });
});
