import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { ToolArtifactEntry, ToolManifest } from "@lando/sdk/schema";

const decodeManifest = Schema.decodeUnknownSync(ToolManifest);
const decodeEntry = Schema.decodeUnknownSync(ToolArtifactEntry);

describe("ToolManifest", () => {
  test("decodes a valid multi-platform-keyed manifest", () => {
    const manifest = decodeManifest({
      schemaVersion: 1,
      toolVersion: "v0.18.1",
      artifacts: {
        "linux-x64/cli": {
          url: "https://example.test/mutagen_linux_amd64.tar.gz",
          sha256: "a".repeat(64),
          archive: "tar.gz",
          member: "mutagen",
          installName: "mutagen",
        },
        "linux-x64/agent/linux-amd64": {
          url: "https://example.test/mutagen_linux_amd64.tar.gz",
          sha256: "a".repeat(64),
          sizeBytes: 102172827,
          archive: "tar.gz",
          member: "mutagen-agents.tar.gz/linux_amd64",
          installName: "mutagen-agents/mutagen-agent-linux-amd64",
          mode: "0755",
        },
        "win32-x64/cli": {
          url: "https://example.test/mutagen_windows_amd64.zip",
          sha256: "b".repeat(64),
          archive: "zip",
          member: "mutagen.exe",
          installName: "mutagen.exe",
        },
      },
    });

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.toolVersion).toBe("v0.18.1");
    expect(Object.keys(manifest.artifacts).sort()).toEqual([
      "linux-x64/agent/linux-amd64",
      "linux-x64/cli",
      "win32-x64/cli",
    ]);
    expect(manifest.artifacts["linux-x64/cli"].installName).toBe("mutagen");
  });

  test("rejects schemaVersion other than 1", () => {
    expect(() =>
      decodeManifest({
        schemaVersion: 2,
        toolVersion: "v0.18.1",
        artifacts: {},
      }),
    ).toThrow();
  });

  test("artifacts is a string-keyed record of ToolArtifactEntry", () => {
    const manifest = decodeManifest({ schemaVersion: 1, toolVersion: "x", artifacts: {} });
    expect(manifest.artifacts).toEqual({});
  });
});

describe("ToolArtifactEntry", () => {
  test("requires url, sha256, installName; archive/member/mode/sizeBytes optional", () => {
    const entry = decodeEntry({
      url: "https://example.test/raw-binary",
      sha256: "c".repeat(64),
      installName: "mkcert",
    });
    expect(entry.url).toBe("https://example.test/raw-binary");
    expect(entry.installName).toBe("mkcert");
    expect(entry.archive).toBeUndefined();
    expect(entry.member).toBeUndefined();
    expect(entry.mode).toBeUndefined();
    expect(entry.sizeBytes).toBeUndefined();
  });

  test("rejects a missing installName", () => {
    expect(() => decodeEntry({ url: "https://example.test/x", sha256: "d".repeat(64) })).toThrow();
  });

  test("archive only accepts tar.gz or zip", () => {
    expect(() =>
      decodeEntry({
        url: "https://example.test/x",
        sha256: "e".repeat(64),
        installName: "x",
        archive: "rar",
      }),
    ).toThrow();
  });
});
