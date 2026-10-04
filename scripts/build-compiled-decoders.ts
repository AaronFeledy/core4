#!/usr/bin/env bun
import { resolve } from "node:path";

import { SchemaAOTCompiler } from "effect/schema";

import { COMPILED_DECODER_ASTS } from "../core/src/cli/compiled-decoder-targets.ts";
import { writeFormattedOutput } from "./_codegen-output.ts";

const OUTPUT_DIR = resolve(import.meta.dirname, "../core/src/cli/generated");
const MODULE_PATH = resolve(OUTPUT_DIR, "compiled-decoders.mjs");
const DECLARATION_PATH = resolve(OUTPUT_DIR, "compiled-decoders.d.mts");

const DECLARATION = `/**
 * **GENERATED FILE** — do not edit by hand.
 *
 * Regenerate via \`bun run scripts/build-compiled-decoders.ts\`.
 */
import type { SchemaAST } from "effect";

export declare function install(asts: ReadonlyArray<SchemaAST.AST>): void;
`;

if (import.meta.main) {
  const source = SchemaAOTCompiler.compile(
    COMPILED_DECODER_ASTS.map((ast) => ({ ast, operations: ["decode"] as const })),
  );
  // The compiler output is several hundred KB of machine-shaped JS; Biome does not
  // finish on it in reasonable time, so only the declaration goes through formatting.
  await Bun.write(MODULE_PATH, source);
  await writeFormattedOutput(DECLARATION_PATH, DECLARATION);
  console.log(
    `[build-compiled-decoders] wrote ${MODULE_PATH} (${COMPILED_DECODER_ASTS.length} schemas, ${source.length} bytes)`,
  );
}
