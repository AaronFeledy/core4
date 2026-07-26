import { describe, expect, test } from "bun:test";
import { Either, Schema } from "effect";

import {
  type ComposeVolumeEntry,
  ComposeVolumesField,
  parseShortVolume,
  splitVolumeSpec,
} from "../../src/schema/compose-volumes.ts";

const decodeVolumes = (input: unknown): ReadonlyArray<ComposeVolumeEntry> =>
  Schema.decodeUnknownSync(ComposeVolumesField)(input, { onExcessProperty: "error" });

const decodeVolumesEither = (input: unknown) =>
  Schema.decodeUnknownEither(ComposeVolumesField)(input, { onExcessProperty: "error" });

const rejectedLongCases: ReadonlyArray<
  readonly [label: string, properties: ReadonlyArray<string>, input: unknown]
> = [
  ["consistency", ["consistency"], { type: "volume", source: "db", target: "/data", consistency: "cached" }],
  [
    "bind.propagation",
    ["bind", "propagation"],
    { type: "bind", source: "./src", target: "/app", bind: { propagation: "shared" } },
  ],
  [
    "bind.recursive",
    ["bind", "recursive"],
    { type: "bind", source: "./src", target: "/app", bind: { recursive: "enabled" } },
  ],
  [
    "bind.selinux",
    ["bind", "selinux"],
    { type: "bind", source: "./src", target: "/app", bind: { selinux: "Z" } },
  ],
  [
    "volume.nocopy",
    ["volume", "nocopy"],
    { type: "volume", source: "db", target: "/data", volume: { nocopy: true } },
  ],
  [
    "volume.labels",
    ["volume", "labels"],
    { type: "volume", source: "db", target: "/data", volume: { labels: { tier: "data" } } },
  ],
  [
    "image.subpath",
    ["image", "subpath"],
    { type: "volume", source: "db", target: "/data", image: { subpath: "assets" } },
  ],
];

const rejectedShortCases: ReadonlyArray<readonly [token: string, matrixKey: string]> = [
  ["nocopy", "volumes.volume.nocopy"],
  ["z", "volumes.bind.selinux"],
  ["Z", "volumes.bind.selinux"],
  ["rprivate", "volumes.bind.propagation"],
  ["private", "volumes.bind.propagation"],
  ["rshared", "volumes.bind.propagation"],
  ["shared", "volumes.bind.propagation"],
  ["rslave", "volumes.bind.propagation"],
  ["slave", "volumes.bind.propagation"],
];

describe("ComposeVolumesField", () => {
  test("S21 decodes a long bind with canonical defaults", () => {
    expect(decodeVolumes([{ type: "bind", source: "./src", target: "/app" }])).toEqual([
      {
        type: "bind",
        source: "./src",
        target: "/app",
        readOnly: false,
        createHostPath: true,
      },
    ]);
  });

  test("S22 decodes a long named volume", () => {
    expect(decodeVolumes([{ type: "volume", source: "db", target: "/data" }])).toEqual([
      { type: "volume", source: "db", target: "/data", readOnly: false },
    ]);
  });

  test("S23 decodes long tmpfs options without a source", () => {
    const decoded = decodeVolumes([{ type: "tmpfs", target: "/tmp", tmpfs: { size: 1024, mode: 1777 } }]);

    expect(decoded).toEqual([
      { type: "tmpfs", target: "/tmp", readOnly: false, tmpfs: { size: 1024, mode: 1777 } },
    ]);
    expect(Object.hasOwn(decoded[0] ?? {}, "source")).toBe(false);
  });

  test("S24 decodes an anonymous short volume", () => {
    const decoded = decodeVolumes(["/data"]);

    expect(decoded).toEqual([{ type: "volume", target: "/data", readOnly: false }]);
    expect(decoded[0]?.source).toBeUndefined();
  });

  test("S25 parses a relative short bind without resolving its source", () => {
    expect(parseShortVolume("./src:/app")).toEqual({
      type: "bind",
      source: "./src",
      target: "/app",
      readOnly: false,
      createHostPath: true,
    });
  });

  test("S26 decodes a read-only short named volume", () => {
    expect(decodeVolumes(["named:/data:ro"])).toEqual([
      { type: "volume", source: "named", target: "/data", readOnly: true },
    ]);
  });

  test("S27 maps long read_only to canonical readOnly", () => {
    expect(decodeVolumes([{ type: "volume", source: "db", target: "/data", read_only: true }])).toEqual([
      { type: "volume", source: "db", target: "/data", readOnly: true },
    ]);
  });

  test("S28 preserves long volume.subpath", () => {
    expect(
      decodeVolumes([{ type: "volume", source: "db", target: "/data", volume: { subpath: "cfg" } }]),
    ).toEqual([{ type: "volume", source: "db", target: "/data", readOnly: false, subpath: "cfg" }]);
  });

  test("S29 preserves bind.create_host_path=false", () => {
    expect(
      decodeVolumes([{ type: "bind", source: "./src", target: "/app", bind: { create_host_path: false } }]),
    ).toEqual([
      {
        type: "bind",
        source: "./src",
        target: "/app",
        readOnly: false,
        createHostPath: false,
      },
    ]);
  });

  test("S29 defaults createHostPath to true for a bind", () => {
    expect(decodeVolumes([{ type: "bind", source: "./src", target: "/app" }])).toEqual([
      {
        type: "bind",
        source: "./src",
        target: "/app",
        readOnly: false,
        createHostPath: true,
      },
    ]);
  });

  test.each(rejectedLongCases)("S30 rejects long %s", (_label, properties, input) => {
    const result = decodeVolumesEither([input]);

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      for (const property of properties) expect(String(result.left)).toContain(property);
    }
  });

  test.each(rejectedShortCases)("S31 rejects short mode %s", (token, matrixKey) => {
    const result = decodeVolumesEither([`src:/app:${token}`]);

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(String(result.left)).toContain(matrixKey);
  });

  test("S32 ignores an unknown short mode token", () => {
    expect(decodeVolumes(["src:/app:banana"])).toEqual([
      { type: "volume", source: "src", target: "/app", readOnly: false },
    ]);
  });

  test("S33 preserves a Windows drive-letter source while splitting", () => {
    expect(splitVolumeSpec("C:\\src:/app:ro")).toEqual(["C:\\src", "/app", "ro"]);
  });

  test("S33 decodes a Windows drive-letter source as a bind", () => {
    expect(decodeVolumes(["C:\\src:/app:ro"])).toEqual([
      {
        type: "bind",
        source: "C:\\src",
        target: "/app",
        readOnly: true,
        createHostPath: true,
      },
    ]);
  });

  test("encodes every entry as a nested long object and round-trips lawfully", () => {
    const decoded = decodeVolumes([
      {
        type: "bind",
        source: "./src",
        target: "/app",
        read_only: true,
        bind: { create_host_path: false },
      },
      { type: "volume", source: "db", target: "/data", volume: { subpath: "cfg" } },
      { type: "tmpfs", target: "/tmp", tmpfs: { size: "64m", mode: 1777 } },
    ]);

    const encoded = Schema.encodeSync(ComposeVolumesField)(decoded);

    expect(encoded).toEqual([
      {
        type: "bind",
        source: "./src",
        target: "/app",
        read_only: true,
        bind: { create_host_path: false },
      },
      {
        type: "volume",
        source: "db",
        target: "/data",
        read_only: false,
        volume: { subpath: "cfg" },
      },
      {
        type: "tmpfs",
        target: "/tmp",
        read_only: false,
        tmpfs: { size: "64m", mode: 1777 },
      },
    ]);
    expect(encoded.every((entry) => typeof entry === "object" && entry !== null)).toBe(true);
    expect(decodeVolumes(encoded)).toEqual(decoded);
  });
});
