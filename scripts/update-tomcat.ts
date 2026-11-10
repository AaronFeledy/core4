import { resolve } from "node:path";
import { Schema } from "effect";
import {
  TOMCAT_MAJORS,
  type TomcatMajor,
  TomcatPins,
  activeConfig,
  validateTomcatPair,
} from "./tomcat-config.ts";
import {
  type TomcatFetch,
  resolveTomcatBaseline,
  resolveTomcatImage,
  tomcatFetch,
} from "./tomcat-registry.ts";

export type TomcatSnapshot = {
  readonly pins: TomcatPins;
  readonly configs: Readonly<Record<TomcatMajor, string>>;
};
export const readTomcatSnapshot = async (directory: string): Promise<TomcatSnapshot> => ({
  pins: Schema.decodeUnknownSync(TomcatPins)(await Bun.file(resolve(directory, "pins.json")).json()),
  configs: {
    "9": await Bun.file(resolve(directory, "server-9.xml")).text(),
    "10": await Bun.file(resolve(directory, "server-10.xml")).text(),
    "11": await Bun.file(resolve(directory, "server-11.xml")).text(),
  },
});

export const prepareTomcatUpdate = async (
  previous: TomcatSnapshot,
  request: TomcatFetch,
): Promise<TomcatSnapshot> => {
  const candidates = await Promise.all(
    TOMCAT_MAJORS.map(async (major) => {
      validateTomcatPair(major, previous.pins.majors[major], previous.configs[major]);
      const image = await resolveTomcatImage(major, request);
      const { xml, ...baseline } = await resolveTomcatBaseline(image.version, request);
      const pin = { ...image, ...baseline };
      validateTomcatPair(major, pin, xml);
      return { major, pin, xml };
    }),
  );
  const pins = { ...previous.pins.majors };
  const configs = { ...previous.configs };
  for (const candidate of candidates) {
    pins[candidate.major] = candidate.pin;
    configs[candidate.major] = candidate.xml;
  }
  return { pins: { schemaVersion: 1, majors: pins }, configs };
};

export const reportTomcatUpdate = (previous: TomcatSnapshot, candidate: TomcatSnapshot): string => {
  const lines = ["# Tomcat paired image/config update", "", "## Upstream changes", ""];
  for (const major of TOMCAT_MAJORS) {
    const before = previous.pins.majors[major];
    const after = candidate.pins.majors[major];
    const oldXml = previous.configs[major];
    const newXml = candidate.configs[major];
    if (JSON.stringify(before) === JSON.stringify(after) && oldXml === newXml) {
      lines.push(`- **${major}**: ${after.version}; unchanged.`);
      continue;
    }
    const classification =
      oldXml === newXml
        ? "baseline byte-identical"
        : activeConfig(oldXml) === activeConfig(newXml)
          ? "comments-only bytes changed; review notices"
          : "active configuration or formatting changed; review required";
    let release: string;
    if (before.version !== after.version) {
      release = `${before.version} → ${after.version}`;
    } else if (before.indexDigest !== after.indexDigest) {
      release = `${after.version} image rebuilt`;
    } else {
      release = after.version;
    }
    const index =
      before.indexDigest === after.indexDigest
        ? `\`${after.indexDigest}\` (unchanged)`
        : `\`${before.indexDigest}\` → \`${after.indexDigest}\``;
    lines.push(
      `- **${major}**: ${release}; ${classification}.`,
      `  Index: ${index}.`,
      `  Apache: https://github.com/apache/tomcat/commit/${after.upstreamCommit}`,
      `  Baseline SHA-256: \`${after.configSha256}\`.`,
    );
    if (oldXml !== newXml) {
      lines.push(
        "",
        `### Tomcat ${major} upstream baseline delta (full before/after)`,
        "",
        "```xml",
        oldXml.trimEnd(),
        "```",
        "",
        "```xml",
        newXml.trimEnd(),
        "```",
        "",
      );
    }
  }
  lines.push(
    "",
    "## Lando customization (unchanged)",
    "",
    "Lando parameterizes the reviewed active HTTP connector's port, which defaults to 8080, and adds a RemoteIpValve that reads X-Forwarded-Proto and X-Forwarded-Port. ROOT.xml is a separate build step. Everything else, including the Apache notices, comes from the paired baseline. No whitespace-normalized semantic-equivalence claim is made.",
    "",
  );
  return lines.join("\n");
};

export const updateTomcat = async (directory: string, request: TomcatFetch = tomcatFetch) => {
  const previous = await readTomcatSnapshot(directory);
  const candidate = await prepareTomcatUpdate(previous, request);
  const changed = JSON.stringify(previous) !== JSON.stringify(candidate);
  const report = reportTomcatUpdate(previous, candidate);
  if (changed) {
    for (const major of TOMCAT_MAJORS)
      await Bun.write(resolve(directory, `server-${major}.xml`), candidate.configs[major]);
    await Bun.write(resolve(directory, "pins.json"), `${JSON.stringify(candidate.pins, null, 2)}\n`);
  }
  return { changed, report };
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const usage = "Usage: bun run update:tomcat (explicit network update; --help prints this message)";
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(`${usage}\n`);
  } else {
    if (args.length !== 0) throw new TypeError(usage);
    const result = await updateTomcat(resolve(import.meta.dirname, "../plugins/service-lando/tomcat"));
    process.stdout.write(result.report);
  }
}
