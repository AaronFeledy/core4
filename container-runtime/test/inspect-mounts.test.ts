import { expect, test } from "bun:test";
import { mountObservationFromInspect } from "../src/podman/inspect-mounts.ts";

test.each([
  undefined,
  null,
  {},
  { Mounts: null },
  { Mounts: {} },
  { Mounts: [null] },
  { Mounts: [{ Type: "volume", Destination: 1 }] },
  { Mounts: [{ Type: "bind", Destination: "/app", RW: "false" }] },
])("keeps malformed or absent mount evidence unknown: %j", (body) => {
  expect(mountObservationFromInspect(body)).toEqual({ status: "unknown" });
});

test("distinguishes an observed empty mount table from unavailable evidence", () => {
  expect(mountObservationFromInspect({ Mounts: [] })).toEqual({ status: "present", mounts: [] });
});

test("uses volume names without classifying hex or human names as anonymous", () => {
  const names = ["a".repeat(64), "human-volume"];
  const result = mountObservationFromInspect({
    Mounts: names.map((Name) => ({
      Type: "volume",
      Name,
      Source: `/var/lib/volumes/${Name}/_data`,
      Destination: `/${Name}`,
      RW: true,
    })),
  });
  expect(result).toEqual({
    status: "present",
    mounts: names.map((source) => ({ type: "volume", source, target: `/${source}`, readOnly: false })),
  });
});

test("retains bind, tmpfs, and unrecognized kinds without inventing read-only evidence", () => {
  const result = mountObservationFromInspect({
    Mounts: [
      { Type: "bind", Source: "/host", Destination: "/app", RW: false },
      { Type: "tmpfs", Destination: "/memory", RW: true },
      { Type: "future", Destination: "/future" },
      { Type: "volume", Destination: "/unnamed", Source: "/daemon/path" },
    ],
  });
  expect(result).toEqual({
    status: "present",
    mounts: [
      { type: "bind", source: "/host", target: "/app", readOnly: true },
      { type: "tmpfs", target: "/memory", readOnly: false },
      { type: "unknown", target: "/future" },
      { type: "volume", target: "/unnamed" },
    ],
  });
});
