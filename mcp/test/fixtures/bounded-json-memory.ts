import { Effect } from "effect";

import { stringifyBoundedJson } from "@lando/mcp/bounded-json";

const before = process.memoryUsage().arrayBuffers;
const encoded = await Effect.runPromise(stringifyBoundedJson({ ok: true }, "small payload"));
const retainedArrayBufferBytes = process.memoryUsage().arrayBuffers - before;

process.stdout.write(`${JSON.stringify({ encoded, retainedArrayBufferBytes })}\n`);
