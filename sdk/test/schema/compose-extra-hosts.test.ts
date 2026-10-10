import { describe, expect, test } from "bun:test";
import { Result, Schema } from "effect";

import { ServiceConfig } from "@lando/sdk/schema";

const input = {
  extra_hosts: [
    "db:127.0.0.1",
    "gateway=host-gateway",
    "db=::1",
    "ipv6:2001:db8::1",
    "db:127.0.0.2",
    "ipv6=2001:db8::2",
    "db=127.0.0.1",
  ],
} as const;
const expected = {
  extra_hosts: {
    db: ["127.0.0.1", "::1", "127.0.0.2", "127.0.0.1"],
    gateway: "host-gateway",
    ipv6: ["2001:db8::1", "2001:db8::2"],
  },
} as const;

for (const options of [{}, { onExcessProperty: "error" }] as const) {
  describe(`Compose extra hosts (${options.onExcessProperty ?? "default"})`, () => {
    test("preserves address order and multiplicity when list hosts repeat", () => {
      // Given interleaved hosts using both separators and IPv4/IPv6 addresses.
      // When decoded through the public service contract.
      const decoded = Schema.decodeUnknownSync(ServiceConfig)(input, options);
      // Then single addresses stay strings and repeated addresses become ordered arrays.
      expect(decoded).toEqual(expected);
    });

    test("preserves every address when decoded twice", () => {
      // Given the canonical output from a list containing repeated hosts.
      const decoded = Schema.decodeUnknownSync(ServiceConfig)(input, options);
      // When the merged Landofile pipeline decodes that output again.
      const decodedAgain = Schema.decodeUnknownSync(ServiceConfig)(decoded, options);
      // Then the independently specified canonical values remain lossless.
      expect(decodedAgain).toEqual(expected);
    });

    test("preserves every address when encoded and decoded again", () => {
      // Given canonical output from repeated list hosts.
      const decoded = Schema.decodeUnknownSync(ServiceConfig)(input, options);
      // When passed through an encode/decode round trip.
      const encoded = Schema.encodeSync(ServiceConfig)(decoded, options);
      const roundTrip = Schema.decodeUnknownSync(ServiceConfig)(encoded, options);
      // Then the canonical string/array shape retains every address.
      expect(roundTrip).toEqual(expected);
    });

    test.each([":", "="] as const)("rejects reserved list keys when using %s", (separator) => {
      // Given a reserved hostname after a valid mapping.
      const reserved = { extra_hosts: ["db:127.0.0.1", `__proto__${separator}::1`] };
      // When decoded through the public service contract.
      const result = Schema.decodeUnknownResult(ServiceConfig)(reserved, options);
      // Then rejection retains the reserved-key remediation.
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure.message).toContain('The key "__proto__" is reserved');
    });

    test("preserves safe object keys when hosts match inherited property names", () => {
      // Given repeated hostnames that also name Object.prototype properties.
      const safeKeys = {
        extra_hosts: ["constructor:127.0.0.1", "toString=::1", "constructor=::2", "toString:127.0.0.2"],
      };
      // When decoded through the public service contract.
      const decoded = Schema.decodeUnknownSync(ServiceConfig)(safeKeys, options);
      // Then they are own data properties with all addresses, not inherited values.
      expect(decoded.extra_hosts).toEqual({
        constructor: ["127.0.0.1", "::2"],
        toString: ["::1", "127.0.0.2"],
      });
      expect(Object.hasOwn(decoded.extra_hosts ?? {}, "constructor")).toBe(true);
      expect(Object.hasOwn(decoded.extra_hosts ?? {}, "toString")).toBe(true);
    });
  });
}
