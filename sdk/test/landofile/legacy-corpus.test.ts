import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { isLegacyTagged, parseLegacyLandofile } from "@lando/sdk/landofile";

const FIXTURES = `${import.meta.dir}/../fixtures/lando3`;

const parseFixture = async (name: string) => {
  const file = `${FIXTURES}/${name}`;
  const content = await Bun.file(file).text();
  const document = await Effect.runPromise(parseLegacyLandofile({ mode: "legacy", file, content }));
  return { content, document };
};

const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected a mapping");
  }
  return value as Record<string, unknown>;
};

describe("legacy mode over the Lando 3 corpus", () => {
  test("parses the kitchen-sink Landofile with tags retained as data", async () => {
    const { document } = await parseFixture("kitchen-sink.lando.yml");
    const root = asRecord(document.value);

    expect(document.mode).toBe("legacy");
    expect(document.root?.kind).toBe("mapping");
    expect(Object.keys(asRecord(root.services)).length).toBeGreaterThan(20);

    // Every tag in the corpus survives as data; none is resolved or read.
    expect(document.tags.filter((occurrence) => occurrence.tag === "!load")).toHaveLength(3);
    expect(document.tags.filter((occurrence) => occurrence.tag === "!import")).toHaveLength(3);
    expect(document.tags).toHaveLength(6);

    const tagged = document.tags.map((occurrence) => occurrence.path.join("."));
    expect(tagged.some((path) => path.includes("entrypoint"))).toBe(true);
  });

  test("parses the kitchen-sink global config", async () => {
    const { document } = await parseFixture("kitchen-sink.config.yml");

    expect(Object.keys(asRecord(document.value)).length).toBeGreaterThan(10);
  });

  test("projects block scalars, flow maps, anchors, and merge keys", async () => {
    const { document } = await parseFixture("kitchen-sink.lando.yml");
    const services = asRecord(asRecord(document.value).services);

    // `options: {max-file: "5", max-size: "5m"}` — a populated flow map whose
    // quoted values stay strings rather than becoming numbers.
    const flowValues = JSON.stringify(document.value);
    expect(flowValues).toContain('"max-file":"5"');
    expect(flowValues).toContain('"max-size":"5m"');

    // `<<: *default-web` merges the anchored mapping and never survives as a key.
    const merged = Object.values(services).filter(
      (service): service is Record<string, unknown> =>
        typeof service === "object" && service !== null && !Array.isArray(service),
    );
    expect(merged.every((service) => !("<<" in service))).toBe(true);

    // Block scalars keep their newlines wherever they sit in the tree.
    const multilineStrings = (value: unknown): number => {
      if (typeof value === "string") return value.includes("\n") ? 1 : 0;
      if (Array.isArray(value))
        return value.reduce<number>((total, item) => total + multilineStrings(item), 0);
      if (typeof value === "object" && value !== null) {
        return Object.values(value).reduce<number>((total, item) => total + multilineStrings(item), 0);
      }
      return 0;
    };
    expect(multilineStrings(document.value)).toBeGreaterThan(0);
  });

  test("every span indexes the source text it came from", async () => {
    const { content, document } = await parseFixture("kitchen-sink.lando.yml");
    const root = document.root;
    if (root === null || root.kind !== "mapping") throw new Error("expected a mapping root");

    for (const entry of root.entries) {
      expect(entry.key.span.start.offset).toBeLessThan(entry.key.span.end.offset);
      expect(entry.key.span.end.offset).toBeLessThanOrEqual(content.length);
      expect(content.slice(entry.key.span.start.offset, entry.key.span.end.offset)).toBe(entry.key.text);
    }
  });

  test("a tagged value keeps its tag, value, and span", async () => {
    const { content, document } = await parseFixture("kitchen-sink.lando.yml");

    const occurrence = document.tags.find((candidate) => candidate.tag === "!import");
    if (occurrence === undefined) throw new Error("expected an import tag");
    expect(content.slice(occurrence.span.start.offset, occurrence.span.end.offset).length).toBeGreaterThan(0);

    let tagged: unknown = document.value;
    for (const segment of occurrence.path) {
      tagged = asRecord(tagged as Record<string, unknown>)[String(segment)] ?? (tagged as never);
      if (isLegacyTagged(tagged)) break;
    }
    expect(isLegacyTagged(tagged)).toBe(true);
  });
});
