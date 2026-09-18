import { describe, expect, it } from "bun:test";

import {
  containerDestinationRefusalMessage,
  normalizeContainerDestination,
  parseContainerDestination,
} from "../../src/schema/container-destination.ts";
import { PortablePath } from "../../src/schema/primitives.ts";

describe("normalizeContainerDestination", () => {
  it("Given a trailing separator, When normalized, Then it is dropped", () => {
    expect(normalizeContainerDestination("/home/node/")).toBe(PortablePath.make("/home/node"));
  });

  it("Given repeated separators, When normalized, Then they collapse", () => {
    expect(normalizeContainerDestination("/home//node")).toBe(PortablePath.make("/home/node"));
  });

  it("Given dot segments, When normalized, Then they resolve away", () => {
    expect(normalizeContainerDestination("/home/./other/../node")).toBe(PortablePath.make("/home/node"));
  });

  it("Given parent segments above the top, When normalized, Then they clamp at root", () => {
    expect(normalizeContainerDestination("/a/../../b")).toBe(PortablePath.make("/b"));
  });

  it("Given a colon in a segment, When normalized, Then it is preserved", () => {
    expect(normalizeContainerDestination("/srv/a:b/")).toBe(PortablePath.make("/srv/a:b"));
  });

  it("Given an already canonical path, When normalized, Then it is unchanged", () => {
    expect(normalizeContainerDestination("/var/lib/mysql")).toBe(PortablePath.make("/var/lib/mysql"));
  });
});

describe("parseContainerDestination", () => {
  it("Given an absolute path, When parsed, Then it yields the canonical form", () => {
    expect(parseContainerDestination("/var//www/./")).toEqual({
      ok: true,
      value: PortablePath.make("/var/www"),
    });
  });

  it("Given a relative path, When parsed, Then it is refused as non-absolute", () => {
    expect(parseContainerDestination("app/data")).toEqual({ ok: false, reason: "not-absolute" });
  });

  it("Given a bare dot, When parsed, Then it is refused as non-absolute", () => {
    expect(parseContainerDestination(".")).toEqual({ ok: false, reason: "not-absolute" });
  });

  it("Given a bare double dot, When parsed, Then it is refused as non-absolute", () => {
    expect(parseContainerDestination("..")).toEqual({ ok: false, reason: "not-absolute" });
  });

  it("Given an empty destination, When parsed, Then it is refused as non-absolute", () => {
    expect(parseContainerDestination("")).toEqual({ ok: false, reason: "not-absolute" });
  });

  it("Given the filesystem root, When parsed, Then it is refused", () => {
    expect(parseContainerDestination("/")).toEqual({ ok: false, reason: "root" });
  });

  it("Given repeated separators that resolve to root, When parsed, Then it is refused", () => {
    expect(parseContainerDestination("///")).toEqual({ ok: false, reason: "root" });
  });

  it("Given parent segments that resolve to root, When parsed, Then it is refused", () => {
    expect(parseContainerDestination("/a/..")).toEqual({ ok: false, reason: "root" });
  });

  it("Given a colon-bearing absolute path, When parsed, Then it is accepted", () => {
    expect(parseContainerDestination("/srv/a:b")).toEqual({
      ok: true,
      value: PortablePath.make("/srv/a:b"),
    });
  });
});

describe("containerDestinationRefusalMessage", () => {
  it("Given a non-absolute refusal, When phrased, Then it names the leading separator", () => {
    expect(containerDestinationRefusalMessage("not-absolute", "app/data")).toContain(
      'must be an absolute path starting with "/"',
    );
  });

  it("Given a root refusal, When phrased, Then it names the provider limit", () => {
    expect(containerDestinationRefusalMessage("root", "/a/..")).toContain(
      "cannot mount over the filesystem root",
    );
  });
});
