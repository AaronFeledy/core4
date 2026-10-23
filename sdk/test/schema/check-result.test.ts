import { expect, test } from "bun:test";
import { CheckResult } from "@lando/sdk/schema";
import { Result, Schema } from "effect";

test.each(["ready", "app-error", "service-error", "lando-error"] as const)(
  "round-trips HTTP check verdict %s",
  (verdict) => {
    const input: typeof CheckResult.Encoded = {
      id: "http:web:http://localhost/",
      kind: "http",
      service: "web",
      url: "http://localhost/",
      verdict,
      statusCode: 500,
      message: "answer",
      detail: "HTTP 500",
    };
    const decoded = Schema.decodeUnknownSync(CheckResult)(input);
    expect(Schema.encodeSync(CheckResult)(decoded)).toEqual(input);
  },
);

test.each([{ kind: "tcp" }, { verdict: "expected" }, { statusCode: "500" }, { service: 5 }])(
  "rejects invalid check fields %j",
  (fields) => {
    const input = {
      id: "http:web:http://localhost/",
      kind: "http",
      service: "web",
      url: "http://localhost/",
      verdict: "ready",
      ...fields,
    };
    expect(Result.isFailure(Schema.decodeUnknownResult(CheckResult)(input))).toBe(true);
  },
);
