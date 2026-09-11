import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sourceRoot = new URL("../../", import.meta.url);
const checkerPath = "spec/config-translation/check-coordinated-plan.mjs";
const planPath = "spec/config-translation/prd.json";
const indexPath = "spec/config-translation/prd-config-translation-00-index.md";
const milestoneDependencies = [
  "US-609E1",
  "US-609E2",
  "US-609E3",
  "US-609E4",
  "US-609E5",
  "US-609E6",
  "US-609E7",
  "US-609E8",
];
let fixtureRoot;

beforeEach(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "lando-coordinated-plan-"));
  const files = [checkerPath, "core/build.config.ts"];
  for (const directory of ["config-translation", "ir-gaps", "lando3-compat"]) {
    for (const file of [
      "prd.json",
      `prd-${directory}-00-index.md`,
      `prd-${directory}-01-stories.md`,
      "spec-config-translation.md",
      "spec-lando3-compat.md",
      "lando3-gap-analysis.md",
    ]) {
      const path = `spec/${directory}/${file}`;
      if (await Bun.file(new URL(path, sourceRoot)).exists()) files.push(path);
    }
  }
  for (const path of files) {
    await Bun.write(join(fixtureRoot, path), Bun.file(new URL(path, sourceRoot)));
  }
});

afterEach(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

const runChecker = async () => {
  const child = Bun.spawn([process.execPath, "run", join(fixtureRoot, checkerPath)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

const setDependencies = async (id, dependsOn) => {
  const plan = await Bun.file(join(fixtureRoot, planPath)).json();
  await Bun.write(
    join(fixtureRoot, planPath),
    JSON.stringify({
      ...plan,
      userStories: plan.userStories.map((story) => (story.id === id ? { ...story, dependsOn } : story)),
    }),
  );
  const index = await Bun.file(join(fixtureRoot, indexPath)).text();
  await Bun.write(
    join(fixtureRoot, indexPath),
    index
      .split("\n")
      .map((line) => {
        const cells = line.split("|");
        if (cells[2]?.trim() !== id) return line;
        cells[cells.length - 2] = ` ${dependsOn.length ? dependsOn.join(", ") : "none"} `;
        return cells.join("|");
      })
      .join("\n"),
  );
};

describe("coordinated plan CLI", () => {
  test("accepts the actual coordinated plan with both loader enablers", async () => {
    const result = await runChecker();
    expect(result.exitCode, result.stderr).toBe(0);
  });

  for (const dependency of milestoneDependencies) {
    test(`rejects a missing milestone dependency ${dependency} with matching index`, async () => {
      await setDependencies(
        "US-609E",
        milestoneDependencies.filter((id) => id !== dependency),
      );
      const result = await runChecker();
      expect(result.exitCode).toBe(1);
    });

    test(`rejects a duplicate milestone dependency ${dependency} with matching index`, async () => {
      await setDependencies("US-609E", [...milestoneDependencies, dependency]);
      const result = await runChecker();
      expect(result.exitCode).toBe(1);
    });
  }

  for (const id of ["US-609E7", "US-609E8"]) {
    test(`rejects an omitted loader prerequisite for ${id}`, async () => {
      await setDependencies(id, []);
      const result = await runChecker();
      expect(result.exitCode).toBe(1);
    });
  }

  test("rejects an extra unrelated milestone dependency", async () => {
    await setDependencies("US-609E", [...milestoneDependencies, "US-607"]);
    const result = await runChecker();
    expect(result.exitCode).toBe(1);
  });

  test("rejects cross-directory priority collisions even when the index agrees", async () => {
    const path = join(fixtureRoot, "spec/ir-gaps/prd.json");
    const plan = await Bun.file(path).json();
    await Bun.write(
      path,
      JSON.stringify({
        ...plan,
        userStories: plan.userStories.map((story) =>
          story.id === "US-613" ? { ...story, priority: 19 } : story,
        ),
      }),
    );
    const index = join(fixtureRoot, "spec/ir-gaps/prd-ir-gaps-00-index.md");
    await Bun.write(index, (await Bun.file(index).text()).replace("| 21 | US-613 |", "| 19 | US-613 |"));
    const result = await runChecker();
    expect(result.exitCode).toBe(1);
  });

  test("rejects forbidden punctuation outside story text", async () => {
    const path = join(fixtureRoot, indexPath);
    await Bun.write(path, `${await Bun.file(path).text()}\n\u2014\n`);
    const result = await runChecker();
    expect(result.exitCode).toBe(1);
  });
});
