import { expect, test } from "bun:test";
import { Effect } from "effect";
import { makeRedactionService } from "../src/service.ts";

test.each(["ABC123", "[redacted]", "[redacted]opaque-suffix"])(
  "signed-query diagnostic masks remain stable across boundaries for %s",
  (value) => {
    // Given
    const service = makeRedactionService();
    const redactor = Effect.runSync(service.forProfile("secrets"));
    const diagnostic = `socket?token=${value}&X-Amz-Signature=deadbeef`;
    // When
    const result = redactor.redactString(redactor.redactString(diagnostic));
    // Then
    expect(result).toBe("socket?token=[redacted]&X-Amz-Signature=[redacted]");
  },
);
