import { describe, expect, test } from "bun:test";
import { sha256Hex } from "@lando/sdk/digest";
import { ServiceName } from "@lando/sdk/schema";

import {
  CONTAINER_HOSTNAME_HASH_LENGTH,
  CONTAINER_HOSTNAME_MAX_LENGTH,
  defaultContainerHostname,
  resolveContainerHostname,
  sanitizeContainerHostname,
} from "../src/hostname.ts";

const hash = (value: string): string => sha256Hex(value).slice(0, CONTAINER_HOSTNAME_HASH_LENGTH);

describe("sanitizeContainerHostname", () => {
  test("lowercases, replaces non-label characters, collapses repeats, and trims hyphens", () => {
    expect(sanitizeContainerHostname("My.App--Web!")).toBe("my-app-web");
    expect(sanitizeContainerHostname("-Leading_and_Trailing-")).toBe("leading-and-trailing");
    expect(sanitizeContainerHostname("already-valid")).toBe("already-valid");
  });

  test("falls back to a hash of the raw value when sanitization is empty", () => {
    expect(sanitizeContainerHostname("!!!")).toBe(hash("!!!"));
    expect(sanitizeContainerHostname("---")).toBe(hash("---"));
  });

  test("keeps names at the 63-character cap without hashing", () => {
    const exact = "a".repeat(CONTAINER_HOSTNAME_MAX_LENGTH);
    expect(sanitizeContainerHostname(exact)).toBe(exact);
  });

  test("appends a hash of the full sanitized name when truncation is required", () => {
    const cleaned = `${"a".repeat(70)}-web`;
    const expected = `${cleaned.slice(0, CONTAINER_HOSTNAME_MAX_LENGTH - CONTAINER_HOSTNAME_HASH_LENGTH - 1)}-${hash(cleaned)}`;
    expect(sanitizeContainerHostname(cleaned)).toBe(expected);
    expect(sanitizeContainerHostname(cleaned).length).toBe(CONTAINER_HOSTNAME_MAX_LENGTH);
  });

  test("avoids collisions when long names share a naive 63-character prefix", () => {
    const left = `${"queue-worker-primary".repeat(5)}-alpha`;
    const right = `${"queue-worker-primary".repeat(5)}-beta`;
    expect(left.slice(0, CONTAINER_HOSTNAME_MAX_LENGTH)).toBe(right.slice(0, CONTAINER_HOSTNAME_MAX_LENGTH));
    expect(sanitizeContainerHostname(left)).not.toBe(sanitizeContainerHostname(right));
    expect(sanitizeContainerHostname(left).length).toBeLessThanOrEqual(CONTAINER_HOSTNAME_MAX_LENGTH);
    expect(sanitizeContainerHostname(right).length).toBeLessThanOrEqual(CONTAINER_HOSTNAME_MAX_LENGTH);
  });

  test("hashes the sanitized form so case and punctuation variants stay identical", () => {
    const left = `${"Queue.Worker!".repeat(6)}-Alpha`;
    const right = `${"queue-worker-".repeat(6)}alpha`;
    expect(sanitizeContainerHostname(left)).toBe(sanitizeContainerHostname(right));
  });
});

describe("default and resolved container hostnames", () => {
  test("defaults to the sanitized app slug and service name", () => {
    expect(defaultContainerHostname("My App", "Web!")).toBe("my-app-web");
    expect(resolveContainerHostname({ slug: "myapp" }, { name: ServiceName.make("web") })).toBe("myapp-web");
  });

  test("uses an authored override without sanitizing it again", () => {
    expect(
      resolveContainerHostname({ slug: "myapp" }, { name: ServiceName.make("web"), hostname: "broker" }),
    ).toBe("broker");
  });
});
