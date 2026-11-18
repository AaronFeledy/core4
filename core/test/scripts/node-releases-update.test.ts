import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NODE_RELEASES_SOURCE,
  NodeReleasesError,
  type NodeReleasesManifest,
  decodeNodeReleasesManifest,
  diffNodeReleases,
  latestLtsMajor,
  reportNodeReleasesUpdate,
  transformNodeSchedule,
} from "../../../scripts/node-releases.ts";
import {
  type NodeScheduleFetch,
  unshippedLtsFailure,
  updateNodeReleases,
} from "../../../scripts/update-node-releases.ts";

const TODAY = "2026-11-16";

const baseManifest: NodeReleasesManifest = {
  schemaVersion: 1,
  source: NODE_RELEASES_SOURCE,
  releases: [
    { major: 22, codename: "jod", lts: "2024-10-29", end: "2027-04-30" },
    { major: 24, codename: "krypton", lts: "2025-10-28", end: "2028-04-30" },
    { major: 26, codename: "lithium", lts: "2026-10-28", end: "2029-04-30" },
  ],
};

const schedule = {
  v22: {
    codename: "Jod",
    end: "2027-04-30",
    lts: "2024-10-29",
    maintenance: "2025-10-21",
    start: "2024-04-24",
  },
  v24: {
    codename: "Krypton",
    end: "2028-04-30",
    lts: "2025-10-28",
    maintenance: "2026-10-20",
    start: "2025-05-06",
  },
  v26: {
    codename: "Lithium",
    end: "2029-04-30",
    lts: "2026-10-28",
    maintenance: "2027-10-20",
    start: "2026-05-05",
  },
  v27: {
    alpha: "2026-10-28",
    codename: "",
    end: "2030-04-30",
    lts: "2027-10-20",
    start: "2027-04-22",
  },
  v28: {
    codename: "Mendelevium",
    end: "2031-04-30",
    lts: "2028-10-25",
    maintenance: "2029-10-23",
    start: "2028-05-04",
  },
};

const responseFor =
  (body: unknown): NodeScheduleFetch =>
  async () =>
    new Response(JSON.stringify(body), { status: 200 });

describe("Node release schedule transform", () => {
  test("refreshes supported majors and lowercases their codenames", () => {
    const update = transformNodeSchedule(schedule, baseManifest, TODAY);

    expect(update.manifest.releases.map((release) => release.major)).toEqual([22, 24, 26]);
    expect(update.manifest.releases).toEqual([
      { major: 22, codename: "jod", lts: "2024-10-29", end: "2027-04-30" },
      { major: 24, codename: "krypton", lts: "2025-10-28", end: "2028-04-30" },
      { major: 26, codename: "lithium", lts: "2026-10-28", end: "2029-04-30" },
    ]);
    expect(update.newLtsMajors).toEqual([]);
  });

  test("reports a new LTS major without adding it to the supported set", () => {
    const update = transformNodeSchedule(schedule, baseManifest, "2028-11-01");

    expect(update.manifest.releases.map((release) => release.major)).toEqual([22, 24, 26]);
    expect(update.newLtsMajors).toEqual([{ major: 28, codename: "mendelevium", lts: "2028-10-25" }]);
  });

  test("records an LTS date only once the major has entered LTS", () => {
    const current: NodeReleasesManifest = {
      ...baseManifest,
      releases: baseManifest.releases.map((release) =>
        release.major === 26 ? { ...release, codename: null, lts: null } : release,
      ),
    };

    const before = transformNodeSchedule(schedule, current, "2026-10-27");
    expect(before.manifest.releases.find((release) => release.major === 26)?.lts).toBeNull();
    expect(latestLtsMajor(before.manifest)).toBe(24);

    const after = transformNodeSchedule(schedule, current, "2026-10-28");
    expect(after.manifest.releases.find((release) => release.major === 26)?.lts).toBe("2026-10-28");
    expect(latestLtsMajor(after.manifest)).toBe(26);
  });

  test("fails loudly on malformed or incomplete schedule input", () => {
    expect(() => transformNodeSchedule("not-an-object", baseManifest, TODAY)).toThrow(NodeReleasesError);
    expect(() => transformNodeSchedule({ v22: { lts: 5 } }, baseManifest, TODAY)).toThrow(NodeReleasesError);
    expect(() =>
      transformNodeSchedule({ v22: schedule.v22, v24: schedule.v24 }, baseManifest, TODAY),
    ).toThrow(/missing v26/u);
  });

  test("rejects unsorted or duplicate manifest majors", () => {
    const [release22, release24, release26] = baseManifest.releases;
    if (release22 === undefined || release24 === undefined || release26 === undefined) {
      throw new Error("Node release manifest fixture is incomplete.");
    }
    expect(() =>
      decodeNodeReleasesManifest({
        ...baseManifest,
        releases: [release24, release22, release26],
      }),
    ).toThrow(/sorted ascending/u);
    expect(() =>
      decodeNodeReleasesManifest({
        ...baseManifest,
        releases: [release22, release22],
      }),
    ).toThrow(/sorted ascending/u);
  });
});

describe("Node release diff and report", () => {
  test("reports the LTS alias move and a newly added supported major", () => {
    const before: NodeReleasesManifest = {
      ...baseManifest,
      releases: [
        ...baseManifest.releases.slice(0, 2),
        { major: 26, codename: "lithium", lts: null, end: "2029-04-30" },
        { major: 28, codename: "mendelevium", lts: null, end: "2031-04-30" },
      ],
    };
    const after: NodeReleasesManifest = {
      ...baseManifest,
      releases: [
        ...baseManifest.releases,
        { major: 28, codename: "mendelevium", lts: "2028-10-25", end: "2031-04-30" },
      ],
    };

    const diff = diffNodeReleases(before, after);
    expect(diff.changed.map((change) => change.major)).toEqual([26, 28]);
    expect(diff.removedMajors).toEqual([]);
    expect(latestLtsMajor(before)).toBe(24);
    expect(latestLtsMajor(after)).toBe(28);

    const body = reportNodeReleasesUpdate(before, after);
    expect(body).toContain("node:28");
    expect(body).toContain("28");
  });

  test("flags an unsupported new LTS major with the manifest path", () => {
    const update = transformNodeSchedule(schedule, baseManifest, "2028-11-01");
    const body = reportNodeReleasesUpdate(baseManifest, update.manifest, update.newLtsMajors);

    expect(body).toContain("28");
    expect(body).toContain("mendelevium");
    expect(body).toContain("plugins/service-lando/node/releases.json");
  });

  test("reports a removed supported major", () => {
    const after: NodeReleasesManifest = {
      ...baseManifest,
      releases: baseManifest.releases.slice(0, 2),
    };

    expect(diffNodeReleases(baseManifest, after).removedMajors).toEqual([26]);
  });
});

describe("Node release updater", () => {
  test("writes only a changed manifest through an injected fetch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "node-releases-update-"));
    const manifestPath = join(directory, "releases.json");
    try {
      await Bun.write(manifestPath, `${JSON.stringify(baseManifest, null, 2)}\n`);

      const current = await updateNodeReleases(directory, responseFor(schedule), TODAY);
      expect(current.changed).toBe(false);

      const shifted = {
        ...schedule,
        v26: { ...schedule.v26, end: "2029-05-01" },
      };
      const changed = await updateNodeReleases(directory, responseFor(shifted), TODAY);
      expect(changed.changed).toBe(true);
      expect(changed.manifest.releases.find((release) => release.major === 26)?.end).toBe("2029-05-01");
      const written = decodeNodeReleasesManifest(await Bun.file(manifestPath).json());
      expect(written.releases.find((release) => release.major === 26)?.end).toBe("2029-05-01");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("fails when an unshipped major enters LTS and the manifest has nothing to propose", async () => {
    const directory = await mkdtemp(join(tmpdir(), "node-releases-update-"));
    try {
      await Bun.write(join(directory, "releases.json"), `${JSON.stringify(baseManifest, null, 2)}\n`);
      const quiet = await updateNodeReleases(directory, responseFor(schedule), TODAY);
      expect(unshippedLtsFailure(quiet)).toBeUndefined();

      const newLts = await updateNodeReleases(directory, responseFor(schedule), "2028-11-01");
      expect(newLts.changed).toBe(false);
      expect(unshippedLtsFailure(newLts)).toContain("Node 28 (mendelevium)");
      expect(unshippedLtsFailure({ ...newLts, changed: true })).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("fails loudly when the schedule request is not successful", async () => {
    const directory = await mkdtemp(join(tmpdir(), "node-releases-update-"));
    try {
      await Bun.write(join(directory, "releases.json"), `${JSON.stringify(baseManifest, null, 2)}\n`);
      const unavailable: NodeScheduleFetch = async () => new Response("", { status: 503 });
      await expect(updateNodeReleases(directory, unavailable, TODAY)).rejects.toThrow(/HTTP 503/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
