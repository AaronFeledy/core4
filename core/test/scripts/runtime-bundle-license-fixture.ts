import { createHash } from "node:crypto";

export const licenseBytes = new TextEncoder().encode("fixture-license-bytes");
export const fixtureLicense = (version: string, bytes: Uint8Array = licenseBytes) => ({
  spdx: "MIT",
  source: `https://example.test/source/${version}.tar.gz`,
  texts: [
    {
      file: "LICENSE",
      url: `https://example.test/${version}/LICENSE`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  ],
});
