import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import {
  CONTAINER_HOSTNAME_PATTERN,
  ContainerHostname,
  isContainerHostname,
  ServiceConfig,
} from "@lando/sdk/schema";

const decodeService = Schema.decodeUnknownSync(ServiceConfig);
const decodeHostname = Schema.decodeUnknownSync(ContainerHostname);

describe("ContainerHostname", () => {
  test.each(["a", "broker", "myapp-web", "a1", `${"a".repeat(63)}`])("accepts %s", (value) => {
    expect(isContainerHostname(value)).toBe(true);
    expect(decodeHostname(value)).toBe(value);
  });

  test.each([
    ["", "empty"],
    ["-leading", "leading hyphen"],
    ["trailing-", "trailing hyphen"],
    ["Bad.Host", "dot"],
    ["UPPER", "uppercase"],
    ["has_under", "underscore"],
    ["a".repeat(64), "64 characters"],
  ])("rejects %s", (value, _name) => {
    expect(isContainerHostname(value)).toBe(false);
    expect(() => decodeHostname(value)).toThrow();
  });

  test("keeps the published pattern source stable", () => {
    expect(CONTAINER_HOSTNAME_PATTERN.source).toBe("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$");
  });
});

describe("ServiceConfig.hostname", () => {
  test.each([
    ["default options", undefined],
    ["strict excess-property options", { onExcessProperty: "error" } as const],
  ])("round-trips a valid override with %s", (_name, options) => {
    const first = decodeService({ hostname: "broker" }, options);
    const second = decodeService(first, options);
    expect(first.hostname).toBe("broker");
    expect(second).toEqual(first);
  });

  test("rejects an invalid override at the Landofile boundary", () => {
    expect(() => decodeService({ hostname: "Bad.Host" })).toThrow();
  });

  test("omits hostname when the author does not set it", () => {
    expect(decodeService({ image: "nginx:alpine" }).hostname).toBeUndefined();
  });
});
