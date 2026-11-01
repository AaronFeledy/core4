import { createHash } from "node:crypto";

export const minioQaInputs = [
  {
    file: "minio-source.tar.gz",
    url: "https://codeload.github.com/minio/minio/tar.gz/9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a",
    sha256: "45521908307306e925c98d629e1c17d78c8b72b6ee242b1bfb1409f7d8ee5841",
  },
  {
    file: "mc",
    url: "https://github.com/minio/mc/releases/download/RELEASE.2025-08-13T08-35-41Z/mc.linux-amd64.RELEASE.2025-08-13T08-35-41Z",
    sha256: "01f866e9c5f9b87c2b09116fa5d7c06695b106242d829a8bb32990c00312e891",
  },
] as const;

export const verifyQaInput = (bytes: Uint8Array, expected: string): void => {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error(`QA input checksum mismatch: expected ${expected}, got ${actual}`);
};

export const assertImageBuild = (output: string): void => {
  const events: unknown[] = output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (events.length === 0) throw new Error("Container build returned no events");
  for (const event of events) {
    if (typeof event === "object" && event !== null && ("error" in event || "errorDetail" in event)) {
      throw new Error(`Container build failed: ${JSON.stringify(event)}`);
    }
  }
};
