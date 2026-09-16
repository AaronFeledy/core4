import { expect, test } from "bun:test";
import { ServiceConfig, ServiceName } from "@lando/sdk/schema";
import { MailpitServiceConfig } from "@lando/sdk/schema/services/mailpit";
import { Schema } from "effect";

test.each([undefined, false as const, [], ["second", "first", "second"]].map((mailFrom) => ({ mailFrom })))(
  "retains mailFrom across strict repeated decoding: %j",
  ({ mailFrom }) => {
    // Given
    const input = { type: "mailpit", ...(mailFrom === undefined ? {} : { mailFrom }) };
    const decode = Schema.decodeUnknownSync(ServiceConfig, { onExcessProperty: "error" });
    // When
    const result = decode(decode(input));
    // Then
    expect(result.mailFrom).toEqual(
      Array.isArray(mailFrom) ? mailFrom.map((name) => ServiceName.make(name)) : mailFrom,
    );
    expect(Schema.decodeUnknownSync(MailpitServiceConfig)(result).mailFrom).toEqual(result.mailFrom);
  },
);

test.each([true, "sender", [3]].map((mailFrom) => ({ mailFrom })))(
  "rejects malformed mailFrom: %j",
  ({ mailFrom }) => {
    // Given / When / Then
    expect(() => Schema.decodeUnknownSync(ServiceConfig)({ mailFrom })).toThrow();
  },
);

test("retains Redis password and ephemeral intent across strict repeated decoding", () => {
  // Given
  const input = { type: "redis", password: "a-redis-password", persist: false };
  const decode = Schema.decodeUnknownSync(ServiceConfig, { onExcessProperty: "error" });
  // When
  const result = decode(decode(input));
  // Then
  expect(result).toMatchObject(input);
});
