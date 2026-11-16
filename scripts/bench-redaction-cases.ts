/**
 * Benchmark cases for the redaction benchmark.
 *
 * Each case returns a closure that performs one measured iteration, or
 * `undefined` when the target checkout lacks the module or export it needs.
 */
import type { OutputRedactionScope } from "@lando/redaction/line-stream";
import type { Redactor } from "@lando/sdk/secrets";
import { type LoadedApi, buildEnvelopeWorkload } from "./bench-redaction-api.ts";
import type { BenchTexts, Corpus } from "./bench-redaction-corpus.ts";

type CaseFactory = (api: LoadedApi, corpus: Corpus, texts: BenchTexts) => (() => void) | undefined;

interface CaseDefinition {
  readonly name: string;
  readonly make: CaseFactory;
}

const drainQueue = (channel: { queue: readonly { chunk: string }[]; shift: () => void }): void => {
  while (channel.queue.length > 0) channel.shift();
};

const lineStreamScope = (redactor: Redactor, values: readonly string[]): OutputRedactionScope => ({
  redactor,
  payloadValues: () => values,
});

export const caseDefinitions: readonly CaseDefinition[] = [
  {
    name: "redactString/0-values",
    make: (api, corpus) => {
      const redactor = api.secrets.createRedactor("secrets");
      return () => {
        redactor.redactString(corpus.text);
      };
    },
  },
  {
    name: "redactString/200-values",
    make: (api, corpus) => {
      const redactor = api.secrets.createRedactor("secrets", {
        values: corpus.values,
        wholeTokenValues: corpus.wholeTokenValues,
      });
      return () => {
        redactor.redactString(corpus.text);
      };
    },
  },
  {
    name: "redactString/trigger-free",
    make: (api, _corpus, texts) => {
      const redactor = api.secrets.createRedactor("secrets");
      return () => {
        redactor.redactString(texts.triggerFree);
      };
    },
  },
  {
    name: "redactString/trigger-heavy",
    make: (api, _corpus, texts) => {
      const redactor = api.secrets.createRedactor("secrets");
      return () => {
        redactor.redactString(texts.triggerHeavy);
      };
    },
  },
  {
    name: "redactString/sparse-secret",
    make: (api, _corpus, texts) => {
      const redactor = api.secrets.createRedactor("secrets");
      return () => {
        redactor.redactString(texts.sparseSecret);
      };
    },
  },
  {
    name: "redactString/adversarial",
    make: (api, _corpus, texts) => {
      const redactor = api.secrets.createRedactor("secrets");
      return () => {
        redactor.redactString(texts.adversarial);
      };
    },
  },
  {
    name: "lineStream/adversarial",
    make: (api, _corpus, texts) => {
      const redact = api.lineStream?.redactLineSequence;
      if (redact === undefined) return undefined;
      const scope = lineStreamScope(api.secrets.createRedactor("secrets"), []);
      const lines = texts.adversarial.split("\n");
      return () => {
        redact(scope, lines);
      };
    },
  },
  {
    name: "lineStream/0-values",
    make: (api, corpus) => {
      const redact = api.lineStream?.redactLineSequence;
      if (redact === undefined) return undefined;
      const scope = lineStreamScope(api.secrets.createRedactor("secrets"), []);
      return () => {
        redact(scope, corpus.lines);
      };
    },
  },
  {
    name: "lineStream/200-values",
    make: (api, corpus) => {
      const redact = api.lineStream?.redactLineSequence;
      if (redact === undefined) return undefined;
      const values = [...corpus.values, ...corpus.wholeTokenValues];
      const scope = lineStreamScope(
        api.secrets.createRedactor("secrets", {
          values: corpus.values,
          wholeTokenValues: corpus.wholeTokenValues,
        }),
        values,
      );
      return () => {
        redact(scope, corpus.lines);
      };
    },
  },
  {
    name: "liveChannelRecord/200-values",
    make: (api, corpus) => {
      const createLiveChannel = api.liveChannel?.createLiveChannel;
      if (createLiveChannel === undefined) return undefined;
      const values = [...corpus.values, ...corpus.wholeTokenValues];
      const redactor = api.secrets.createRedactor("secrets", {
        values: corpus.values,
        wholeTokenValues: corpus.wholeTokenValues,
      });
      const lines = corpus.lines;
      return () => {
        let now = 1_000;
        const channel = createLiveChannel({
          kind: "record",
          redactor,
          payloadValues: () => values,
          timeBound: { maxHeldMillis: 500, now: () => now },
        });
        for (const [index, line] of lines.entries()) {
          if (index % 100 === 0) now += 10;
          channel.feed(line);
          drainQueue(channel);
        }
        channel.end();
        drainQueue(channel);
      };
    },
  },
  {
    name: "liveChannelBytes/200-values",
    make: (api, corpus) => {
      const createLiveChannel = api.liveChannel?.createLiveChannel;
      if (createLiveChannel === undefined) return undefined;
      const values = [...corpus.values, ...corpus.wholeTokenValues];
      const redactor = api.secrets.createRedactor("secrets", {
        values: corpus.values,
        wholeTokenValues: corpus.wholeTokenValues,
      });
      const bytes = new TextEncoder().encode(`${corpus.text}\n`);
      const chunkBytes = 997;
      return () => {
        let now = 1_000;
        const channel = createLiveChannel({
          kind: "bytes",
          redactor,
          payloadValues: () => values,
          timeBound: { maxHeldMillis: 500, now: () => now },
        });
        for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
          if ((offset / chunkBytes) % 100 === 0) now += 10;
          channel.feed(bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.length)));
          drainQueue(channel);
        }
        channel.end();
        drainQueue(channel);
      };
    },
  },
  ...(["json", "yaml"] as const).map(
    (format): CaseDefinition => ({
      name: `envelope${format === "json" ? "Json" : "Yaml"}/200-values`,
      make: (api, corpus) => {
        const encode = api.commandResult?.encodeCommandResult;
        const effect = api.effect;
        if (encode === undefined || effect === undefined) return undefined;
        const workload = buildEnvelopeWorkload(effect);
        const redactor = api.secrets.createRedactor("secrets", {
          values: corpus.values,
          wholeTokenValues: corpus.wholeTokenValues,
        });
        return () => {
          effect.Effect.runSync(
            encode({
              command: "app:config",
              resultSchema: workload.resultSchema,
              outcome: { _tag: "success", value: workload.value },
              redactor,
              format,
            }),
          );
        };
      },
    }),
  ),
  {
    name: "mcpBoundedJson/200-values",
    make: (api, corpus) => {
      const redact = api.boundedJson?.redactBoundedJsonValue;
      const effect = api.effect;
      if (redact === undefined || effect === undefined) return undefined;
      const workload = buildEnvelopeWorkload(effect);
      const redactor = api.secrets.createRedactor("secrets", {
        values: corpus.values,
        wholeTokenValues: corpus.wholeTokenValues,
      });
      return () => {
        effect.Effect.runSync(redact(workload.value, redactor, "bench:redaction"));
      };
    },
  },
];

export const benchCaseNames = caseDefinitions.map((definition) => definition.name);
