#!/usr/bin/env bun
/** Verified upstream Docker CLI pin for the private Windows Mutagen transport. */
import { resolve } from "node:path";
import { ToolManifest } from "@lando/sdk/schema";
import { Schema } from "effect";
import { writeFormattedOutput } from "./_codegen-output.ts";

const output = resolve(import.meta.dirname, "../plugins/file-sync-mutagen/docker-cli-versions.json");
const manifest = Schema.decodeUnknownSync(ToolManifest)({
  schemaVersion: 1,
  toolVersion: "29.3.1",
  artifacts: {
    "win32-x64": {
      url: "https://download.docker.com/win/static/stable/x86_64/docker-29.3.1.zip",
      sha256: "9de0daaed958062d2005e2766c856a6671dd95e6202e1ac801c569e22dff7edf",
      sizeBytes: 46344787,
      archive: "zip",
      member: "docker/docker.exe",
      installName: "mutagen-docker/docker.exe",
    },
  },
});
await writeFormattedOutput(output, `${JSON.stringify(manifest, null, 2)}\n`);
