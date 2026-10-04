import { describe, expect, test } from "bun:test";

import { Result, Schema } from "effect";

import { HostProxyOpenUrlSchemeError, OpenTargetUnresolvedError } from "@lando/sdk/errors";

describe("OpenTargetUnresolvedError", () => {
  test("carries message, known services, and remediation", () => {
    const error = new OpenTargetUnresolvedError({
      message: "No openable target for app myapp.",
      app: "myapp",
      services: ["web", "db"],
      remediation: "Declare a route under `proxy:` in your Landofile.",
    });

    expect(error._tag).toBe("OpenTargetUnresolvedError");
    expect(error.message).toBe("No openable target for app myapp.");
    expect(error.app).toBe("myapp");
    expect(error.services).toEqual(["web", "db"]);
    expect(error.remediation).toContain("proxy:");
  });

  test("decodes through schema preserving fields", () => {
    const decoded = Schema.decodeUnknownResult(OpenTargetUnresolvedError)({
      _tag: "OpenTargetUnresolvedError",
      message: "no routes",
      app: "myapp",
      services: ["web"],
      remediation: "Add a route.",
    });

    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isSuccess(decoded)) {
      expect(decoded.success.services).toEqual(["web"]);
    }
  });
});

describe("HostProxyOpenUrlSchemeError", () => {
  test("carries the offending scheme and url", () => {
    const error = new HostProxyOpenUrlSchemeError({
      message: "Refusing to open a non-http(s) URL.",
      scheme: "ftp",
      url: "ftp://example.test",
      remediation: "Only http and https URLs can be opened.",
    });

    expect(error._tag).toBe("HostProxyOpenUrlSchemeError");
    expect(error.scheme).toBe("ftp");
    expect(error.url).toBe("ftp://example.test");
    expect(error.remediation).toContain("http");
  });

  test("decodes through schema", () => {
    const decoded = Schema.decodeUnknownResult(HostProxyOpenUrlSchemeError)({
      _tag: "HostProxyOpenUrlSchemeError",
      message: "bad scheme",
      scheme: "file",
      url: "file:///etc/passwd",
    });

    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isSuccess(decoded)) {
      expect(decoded.success.scheme).toBe("file");
    }
  });
});
