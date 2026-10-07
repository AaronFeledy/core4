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

const expectFailure = (result, message) => {
  expect(result.exitCode, result.stderr).toBe(1);
  expect(result.stderr).toContain(`\nerror: ${message}\n`);
};

const setDependencies = async (id, dependsOn, directory = "config-translation") => {
  const planPath = `spec/${directory}/prd.json`;
  const indexPath = `spec/${directory}/prd-${directory}-00-index.md`;
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
    expect(result.stdout).toContain("PASS: 75 stories;");
  });

  test("later follow-ups neither expand the earlier closure nor hide its leaves", async () => {
    await setDependencies("US-656", ["US-611B", "US-621C9"], "ir-gaps");
    const result = await runChecker();
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("PASS: 75 stories;");
  });

  test("rejects a missing earlier terminal leaf even when a later follow-up consumes it", async () => {
    await setDependencies("US-656", ["US-621C9"], "ir-gaps");
    await setDependencies("US-622B", ["US-611B", "US-622A"], "lando3-compat");
    const result = await runChecker();
    expectFailure(result, "US-622B must depend on every terminal leaf: US-611B, US-621C9, US-622A");
  });

  test("accepts retired references in notes and explicitly marked history", async () => {
    const path = join(fixtureRoot, planPath);
    const plan = await Bun.file(path).json();
    plan.userStories[0].notes = "Historical predecessor US-99999 was retired.";
    await Bun.write(path, JSON.stringify(plan));
    const markdown = join(fixtureRoot, "spec/ir-gaps/prd-ir-gaps-01-stories.md");
    await Bun.write(
      markdown,
      `${await Bun.file(markdown).text()}\n<!-- plan-history:start -->\nRetired US-99999.\n<!-- plan-history:end -->\n`,
    );
    const result = await runChecker();
    expect(result.exitCode, result.stderr).toBe(0);
  });

  for (const surface of ["index", "prose", "criterion", "notes-punctuation", "history-punctuation"]) {
    test(`still rejects invalid current references or forbidden text in ${surface}`, async () => {
      if (surface === "index") {
        const path = join(fixtureRoot, indexPath);
        await Bun.write(path, `${await Bun.file(path).text()}\nSee US-99999.\n`);
      } else if (surface === "notes-punctuation") {
        const path = join(fixtureRoot, planPath);
        const plan = await Bun.file(path).json();
        plan.userStories[0].notes = "Historical \u2014 note.";
        await Bun.write(path, JSON.stringify(plan));
      } else {
        const path = join(fixtureRoot, "spec/ir-gaps/prd-ir-gaps-01-stories.md");
        const markdown = await Bun.file(path).text();
        if (surface === "criterion") {
          const jsonPath = join(fixtureRoot, "spec/ir-gaps/prd.json");
          const plan = await Bun.file(jsonPath).json();
          const original = plan.userStories[0].acceptanceCriteria[0];
          plan.userStories[0].acceptanceCriteria[0] += " See US-99999.";
          await Bun.write(jsonPath, JSON.stringify(plan));
          await Bun.write(
            path,
            `<!-- plan-history:start -->\n${markdown.replace(original, plan.userStories[0].acceptanceCriteria[0])}\n<!-- plan-history:end -->\n`,
          );
        } else {
          const addition =
            surface === "prose"
              ? "See US-99999."
              : "<!-- plan-history:start -->\nHistorical \u2014 note.\n<!-- plan-history:end -->";
          await Bun.write(path, `${markdown}\n${addition}\n`);
        }
      }
      const result = await runChecker();
      expectFailure(
        result,
        surface.endsWith("punctuation")
          ? "forbidden stale text: \u2014"
          : "stale or unknown story reference US-99999",
      );
    });
  }

  for (const dependency of milestoneDependencies) {
    test(`rejects a missing milestone dependency ${dependency} with matching index`, async () => {
      await setDependencies(
        "US-609E",
        milestoneDependencies.filter((id) => id !== dependency),
      );
      const result = await runChecker();
      expectFailure(
        result,
        ["US-609E6", "US-609E7"].includes(dependency)
          ? `US-609E must depend on exactly: ${milestoneDependencies.join(", ")}`
          : `US-622B must depend on every terminal leaf: ${dependency}, US-611B, US-621C9, US-622A`,
      );
    });

    test(`rejects a duplicate milestone dependency ${dependency} with matching index`, async () => {
      await setDependencies("US-609E", [...milestoneDependencies, dependency]);
      const result = await runChecker();
      expectFailure(result, "US-609E: dependencies must be a unique array");
    });
  }

  for (const id of ["US-609E7", "US-609E8"]) {
    test(`rejects an omitted loader prerequisite for ${id}`, async () => {
      await setDependencies(id, []);
      const result = await runChecker();
      expectFailure(result, `${id} must depend on exactly: ${id === "US-609E7" ? "US-609E6" : "US-609E7"}`);
    });
  }

  test("rejects an extra unrelated milestone dependency", async () => {
    await setDependencies("US-609E", [...milestoneDependencies, "US-607"]);
    const result = await runChecker();
    expectFailure(result, `US-609E must depend on exactly: ${milestoneDependencies.join(", ")}`);
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
    expectFailure(result, "duplicate priority 19");
  });

  test("rejects forbidden punctuation outside story text", async () => {
    const path = join(fixtureRoot, indexPath);
    await Bun.write(path, `${await Bun.file(path).text()}\n\u2014\n`);
    const result = await runChecker();
    expectFailure(result, "forbidden stale text: \u2014");
  });
});
