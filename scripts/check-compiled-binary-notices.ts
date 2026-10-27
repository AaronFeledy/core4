#!/usr/bin/env bun
import { resolve } from "node:path";
import { generateCompiledBinaryNotices } from "./compiled-binary-notices.ts";

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--core-dist")) {
    throw new Error("Usage: bun run scripts/check-compiled-binary-notices.ts [--core-dist]");
  }
  await generateCompiledBinaryNotices();
  if (args[0] === "--core-dist") {
    await Bun.write(
      resolve(import.meta.dirname, "../core/dist/THIRD_PARTY_NOTICES.md"),
      Bun.file(resolve(import.meta.dirname, "../dist/THIRD_PARTY_NOTICES.md")),
    );
  }
}
