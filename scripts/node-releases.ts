import { causeMessage } from "@lando/sdk/errors";
import { Schema } from "effect";

/** Node's authoritative release schedule, fetched by the scheduled bump workflow. */
export const NODE_RELEASES_SOURCE = "https://raw.githubusercontent.com/nodejs/Release/main/schedule.json";
/** Committed pin manifest relative to the repository root. */
export const NODE_RELEASES_MANIFEST_PATH = "plugins/service-lando/node/releases.json";

const IsoDate = Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u)));
const LowercaseCodename = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z][a-z0-9]*$/u)));

/**
 * One supported Node major. `lts` is the schedule's LTS date only once that
 * date has arrived; before then it stays `null` so the manifest itself records
 * which supported majors are LTS. Runtime planning never compares against the
 * wall clock.
 */
export const NodeRelease = Schema.Struct({
  major: Schema.Int.check(Schema.isGreaterThan(0)),
  codename: Schema.NullOr(LowercaseCodename),
  lts: Schema.NullOr(IsoDate),
  end: Schema.NullOr(IsoDate),
});
export type NodeRelease = typeof NodeRelease.Type;

export const NodeReleasesManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  source: Schema.String,
  releases: Schema.Array(NodeRelease),
});
export type NodeReleasesManifest = typeof NodeReleasesManifest.Type;

const NodeScheduleEntry = Schema.Struct({
  alpha: Schema.optionalKey(IsoDate),
  start: Schema.optionalKey(IsoDate),
  lts: Schema.optionalKey(IsoDate),
  maintenance: Schema.optionalKey(IsoDate),
  end: Schema.optionalKey(IsoDate),
  codename: Schema.optionalKey(Schema.String),
});
const NodeSchedule = Schema.Record(Schema.String, NodeScheduleEntry);

export class NodeReleasesError extends Error {
  override readonly name = "NodeReleasesError";

  constructor(readonly detail: string) {
    super(detail);
  }
}

export const decodeNodeReleasesManifest = (input: unknown): NodeReleasesManifest => {
  let manifest: NodeReleasesManifest;
  try {
    manifest = Schema.decodeUnknownSync(NodeReleasesManifest)(input);
  } catch (cause) {
    throw new NodeReleasesError(`Malformed Node release manifest: ${causeMessage(cause)}`);
  }
  for (const [index, release] of manifest.releases.entries()) {
    const previousMajor = manifest.releases[index - 1]?.major;
    if (previousMajor !== undefined && release.major <= previousMajor) {
      throw new NodeReleasesError("Node release manifest majors must be unique and sorted ascending.");
    }
  }
  return manifest;
};

export const readNodeReleasesManifest = async (path: string): Promise<NodeReleasesManifest> =>
  decodeNodeReleasesManifest(await Bun.file(path).json());

export type NewLtsMajor = {
  readonly major: number;
  readonly codename: string;
  readonly lts: string;
};

export type NodeReleasesUpdate = {
  readonly manifest: NodeReleasesManifest;
  readonly newLtsMajors: readonly NewLtsMajor[];
};

const decodeSchedule = (input: unknown) => {
  try {
    return Schema.decodeUnknownSync(NodeSchedule)(input);
  } catch (cause) {
    throw new NodeReleasesError(`Malformed Node release schedule: ${causeMessage(cause)}`);
  }
};

const latestLtsDate = (releases: ReadonlyArray<NodeRelease>): string | null =>
  releases.reduce<string | null>((latest, release) => {
    if (release.lts === null) return latest;
    return latest === null || release.lts > latest ? release.lts : latest;
  }, null);

/**
 * Pure transform from Node's schedule JSON to the committed manifest. It keeps
 * the supported major set from `previous` exactly as-is and only refreshes the
 * codename, LTS date, and end date for those majors. Majors outside that set
 * are reported, never added.
 */
export const transformNodeSchedule = (
  schedule: unknown,
  previous: NodeReleasesManifest,
  today: string,
): NodeReleasesUpdate => {
  const entries = decodeSchedule(schedule);
  const supportedMajors = new Set(previous.releases.map((release) => release.major));
  const releases = previous.releases.map((release): NodeRelease => {
    const entry = entries[`v${release.major}`];
    if (entry === undefined) {
      throw new NodeReleasesError(`Node release schedule is missing v${release.major}.`);
    }
    const codename = entry.codename?.trim();
    const enteredLts = entry.lts !== undefined && entry.lts <= today;
    return {
      major: release.major,
      codename: codename === undefined || codename === "" ? null : codename.toLowerCase(),
      lts: enteredLts ? (entry.lts ?? null) : null,
      end: entry.end ?? null,
    };
  });
  const newestSupportedLts = latestLtsDate(previous.releases);
  const newLtsMajors = Object.entries(entries)
    .flatMap(([key, entry]): NewLtsMajor[] => {
      const match = /^v(\d+)$/u.exec(key);
      if (match === null) return [];
      const major = Number(match[1]);
      if (supportedMajors.has(major)) return [];
      const lts = entry.lts;
      const codename = entry.codename?.trim();
      if (lts === undefined || lts > today) return [];
      if (codename === undefined || codename === "") return [];
      if (newestSupportedLts !== null && lts <= newestSupportedLts) return [];
      return [{ codename: codename.toLowerCase(), lts, major }];
    })
    .sort((left, right) => left.major - right.major);
  return {
    manifest: { schemaVersion: 1, source: NODE_RELEASES_SOURCE, releases },
    newLtsMajors,
  };
};

export type NodeReleaseChange = {
  readonly major: number;
  readonly before: NodeRelease | null;
  readonly after: NodeRelease;
};

export type NodeReleasesDiff = {
  readonly changed: readonly NodeReleaseChange[];
  readonly removedMajors: readonly number[];
};

export const diffNodeReleases = (
  previous: NodeReleasesManifest,
  next: NodeReleasesManifest,
): NodeReleasesDiff => {
  const before = new Map(previous.releases.map((release) => [release.major, release]));
  const nextMajors = new Set(next.releases.map((release) => release.major));
  const changed = next.releases.flatMap((after): NodeReleaseChange[] => {
    const prior = before.get(after.major);
    if (prior === undefined) return [{ after, before: null, major: after.major }];
    if (prior.codename === after.codename && prior.lts === after.lts && prior.end === after.end) {
      return [];
    }
    return [{ after, before: prior, major: after.major }];
  });
  const removedMajors = previous.releases
    .filter((release) => !nextMajors.has(release.major))
    .map((release) => release.major);
  return { changed, removedMajors };
};

export const latestLtsMajor = (manifest: NodeReleasesManifest): number | null =>
  manifest.releases.reduce<number | null>((latest, release) => {
    if (release.lts === null) return latest;
    return latest === null || release.major > latest ? release.major : latest;
  }, null);

export const reportNodeReleasesUpdate = (
  previous: NodeReleasesManifest,
  next: NodeReleasesManifest,
  newLtsMajors: readonly NewLtsMajor[] = [],
): string => {
  const lines = ["# Node release schedule update", ""];
  if (newLtsMajors.length > 0) {
    lines.push(
      "## Action required: new Node LTS major outside the supported catalog",
      "",
      "The scheduled updater never adds majors. Add the record below to `plugins/service-lando/node/releases.json` in a separate change, then run `bun run codegen`.",
      "",
    );
    for (const entry of newLtsMajors) {
      lines.push(`- Node ${entry.major} entered LTS as ${entry.codename} on ${entry.lts}.`);
    }
    lines.push("");
  }

  const diff = diffNodeReleases(previous, next);
  lines.push("## Supported-major changes", "");
  if (diff.changed.length === 0 && diff.removedMajors.length === 0) {
    lines.push("- No supported-major changes; the manifest already matches Node's schedule.");
  } else {
    for (const change of diff.changed) {
      if (change.before === null) {
        lines.push(
          `- Node ${change.major} added with lts ${change.after.lts ?? "not yet announced"} and end ${change.after.end ?? "unknown"}.`,
        );
        continue;
      }
      lines.push(
        `- Node ${change.major}: codename ${change.before.codename} -> ${change.after.codename}, lts ${change.before.lts} -> ${change.after.lts}, end ${change.before.end} -> ${change.after.end}.`,
      );
    }
    for (const major of diff.removedMajors) {
      lines.push(`- Node ${major} was removed from the supported catalog.`);
    }
  }

  const beforeLts = latestLtsMajor(previous);
  const afterLts = latestLtsMajor(next);
  if (afterLts !== null && afterLts !== beforeLts) {
    const codename = next.releases.find((release) => release.major === afterLts)?.codename;
    const codenameText = codename === null || codename === undefined ? "" : ` as ${codename}`;
    lines.push(
      "",
      beforeLts === null || afterLts > beforeLts
        ? `Node ${afterLts} entered LTS${codenameText}; \`lts\` now selects node:${afterLts}.`
        : `\`lts\` now selects node:${afterLts}${codenameText}.`,
    );
  }

  lines.push(
    "",
    "Review the official Node image tags before merging: a new image may change bundled tools such as Yarn and Corepack.",
    "",
  );
  return lines.join("\n");
};
