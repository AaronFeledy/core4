import { createOutputLineRedactor, redactLineSequence } from "@lando/redaction/line-stream";
import { createLiveChannel } from "@lando/redaction/live-channel";
import { REDACTED, type Redactor, createRedactor } from "@lando/sdk/secrets";
import {
  FAMILIES,
  type GeneratedDocument,
  SEEDS,
  buildDocument,
  makeRandom,
  randomInt,
} from "./support/redaction-documents.ts";

const encoder = new TextEncoder();
const MAX_BOUNDED_BYTES = 1 << 20;

const createDocumentRedactor = (doc: GeneratedDocument): Redactor =>
  createRedactor("secrets", {
    values: doc.substringValues,
    wholeTokenValues: doc.wholeTokenValues,
  });

const payloadValues = (doc: GeneratedDocument) => () => ({
  substring: doc.substringValues,
  wholeToken: doc.wholeTokenValues,
});

const assertNoSecret = (output: string, doc: GeneratedDocument, path: string): void => {
  expect(output, `${doc.family}#${doc.seed} (${doc.lineEnding}) emitted no mask on ${path}`).toContain(
    REDACTED,
  );
  for (const secret of doc.secrets) {
    expect(
      output.includes(secret),
      `${doc.family}#${doc.seed} (${doc.lineEnding}) leaked ${secret} on ${path}`,
    ).toBe(false);
  }
};

const drain = (
  channel: {
    readonly queue: readonly { readonly chunk: string }[];
    readonly shift: () => void;
    readonly expire: () => void;
  },
  chunks: string[],
): void => {
  while (channel.queue.length > 0) {
    const head = channel.queue[0];
    if (head !== undefined) chunks.push(head.chunk);
    channel.shift();
  }
  channel.expire();
  while (channel.queue.length > 0) {
    const head = channel.queue[0];
    if (head !== undefined) chunks.push(head.chunk);
    channel.shift();
  }
};

const runDocument = (doc: GeneratedDocument): void => {
  const redactor = createDocumentRedactor(doc);
  const scope = { redactor, payloadValues: payloadValues(doc) };
  const random = makeRandom(doc.seed * 1_000 + doc.family.length);

  // Complete text: every secret masked, every public canary intact.
  const complete = redactor.redactString(doc.text);
  assertNoSecret(complete, doc, "redactString");
  for (const value of doc.publics) {
    expect(
      complete.includes(value),
      `${doc.family}#${doc.seed} (${doc.lineEnding}) lost public ${value}`,
    ).toBe(true);
  }

  // Idempotence.
  expect(redactor.redactString(complete), `${doc.family}#${doc.seed} is not idempotent`).toBe(complete);

  // Bounded output masks exactly what unbounded output masks.
  const bounded = redactor.redactStringBounded?.(doc.text, MAX_BOUNDED_BYTES);
  expect(bounded, `${doc.family}#${doc.seed} has no bounded redactor`).toBe(complete);

  // A line sequence keeps every released line in order.
  const sequence = redactLineSequence(scope, doc.text.split("\n"))
    .filter((line): line is string => line !== undefined)
    .join("\n");
  assertNoSecret(sequence, doc, "redactLineSequence");

  // Raw bytes in random chunk sizes, as a process pipe delivers them.
  const bytes = encoder.encode(doc.text);
  const output = createOutputLineRedactor(scope);
  const streamed: string[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const end = Math.min(offset + 1 + randomInt(random, 63), bytes.length);
    streamed.push(...output.write(bytes.subarray(offset, end)));
    offset = end;
  }
  streamed.push(...output.end());
  assertNoSecret(streamed.join("\n"), doc, "outputLineRedactor");

  // Live record channel with a caller-owned clock that both stays inside and
  // crosses the 500 ms hold.
  {
    let now = 1_000;
    const recordChannel = createLiveChannel({
      kind: "record",
      redactor,
      payloadValues: payloadValues(doc),
      timeBound: { maxHeldMillis: 500, now: () => now },
    });
    const records: string[] = [];
    for (const line of doc.text.split("\n")) {
      if (random() < 0.4) now += randomInt(random, 700);
      recordChannel.feed(line);
      drain(recordChannel, records);
    }
    recordChannel.end();
    drain(recordChannel, records);
    assertNoSecret(records.join(""), doc, "liveChannelRecord");
  }

  // Live byte channel with random chunking and clock advances.
  {
    let byteNow = 1_000;
    const byteChannel = createLiveChannel({
      kind: "bytes",
      redactor,
      payloadValues: payloadValues(doc),
      timeBound: { maxHeldMillis: 500, now: () => byteNow },
    });
    const pieces: string[] = [];
    let byteOffset = 0;
    while (byteOffset < bytes.length) {
      if (random() < 0.4) byteNow += randomInt(random, 700);
      const end = Math.min(byteOffset + 1 + randomInt(random, 63), bytes.length);
      byteChannel.feed(bytes.subarray(byteOffset, end));
      drain(byteChannel, pieces);
      byteOffset = end;
    }
    byteChannel.end();
    drain(byteChannel, pieces);
    assertNoSecret(pieces.join(""), doc, "liveChannelBytes");
  }
};

describe("redaction generative round trip", () => {
  for (const family of FAMILIES) {
    describe(family, () => {
      for (let seed = 0; seed < SEEDS; seed += 1) {
        for (const lineEnding of ["lf", "crlf"] as const) {
          test(`${family} seed ${seed} ${lineEnding}`, () => {
            runDocument(buildDocument(family, seed, lineEnding));
          });
        }
      }
    });
  }
});
