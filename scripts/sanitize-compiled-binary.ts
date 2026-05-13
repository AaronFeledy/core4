#!/usr/bin/env bun

const [binaryPath] = Bun.argv.slice(2);

if (binaryPath === undefined) {
  throw new Error("Usage: sanitize-compiled-binary.ts <binary-path>");
}

const replacements = new Map([[".tsbuildinfo", ".tsbuildnoop"]]);
const bytes = new Uint8Array(await Bun.file(binaryPath).arrayBuffer());
let replacementCount = 0;

for (const [forbidden, replacement] of replacements) {
  const forbiddenBytes = new TextEncoder().encode(forbidden);
  const replacementBytes = new TextEncoder().encode(replacement);

  if (forbiddenBytes.length !== replacementBytes.length) {
    throw new Error(`Replacement for ${forbidden} must be byte-length preserving.`);
  }

  for (let index = 0; index <= bytes.length - forbiddenBytes.length; index += 1) {
    let matches = true;

    for (let offset = 0; offset < forbiddenBytes.length; offset += 1) {
      if (bytes[index + offset] !== forbiddenBytes[offset]) {
        matches = false;
        break;
      }
    }

    if (!matches) continue;

    bytes.set(replacementBytes, index);
    replacementCount += 1;
  }
}

if (replacementCount > 0) {
  await Bun.write(binaryPath, bytes);
}
