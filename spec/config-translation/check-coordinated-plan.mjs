const root = new URL("../", import.meta.url);
const args = Bun.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log(
    "Usage: bun run spec/config-translation/check-coordinated-plan.mjs [--initial]\nChecks plan consistency and completed-story prerequisites. --initial also requires all stories to be unstarted.",
  );
  process.exit(0);
}
if (args.some((arg) => arg !== "--initial") || args.length > 1) {
  console.error("Unknown argument. Use --help or --initial.");
  process.exit(2);
}
const initial = args.includes("--initial");

const sets = [
  {
    directory: "config-translation",
    stories: "prd-config-translation-01-stories.md",
    index: "prd-config-translation-00-index.md",
  },
  {
    directory: "ir-gaps",
    stories: "prd-ir-gaps-01-stories.md",
    index: "prd-ir-gaps-00-index.md",
  },
  {
    directory: "lando3-compat",
    stories: "prd-lando3-compat-01-stories.md",
    index: "prd-lando3-compat-00-index.md",
  },
];

const fail = (message) => {
  throw new Error(message);
};

const read = (directory, file) => Bun.file(new URL(`${directory}/${file}`, root)).text();

const parseMarkdownStories = (text, source) => {
  const stories = [
    ...text.matchAll(
      /^### (US-\d+[A-Z0-9]*): (.+)\n\n\*\*Description:\*\* (.+)\n\n(?:\*\*Recipe IDs:\*\* (.+)\n\n)?\*\*Acceptance Criteria:\*\*\n((?:- \[ \] .+\n?)+)/gm,
    ),
  ].map((match) => ({
    id: match[1],
    title: match[2],
    description: match[3],
    ...(match[4] === undefined
      ? {}
      : { recipeIds: [...match[4].matchAll(/`([^`]+)`/g)].map((recipe) => recipe[1]) }),
    acceptanceCriteria: match[5]
      .trim()
      .split("\n")
      .map((line) => line.slice(6)),
  }));
  if (stories.length === 0) fail(`${source}: no stories parsed`);
  if (stories.length !== [...text.matchAll(/^### US-/gm)].length) {
    fail(`${source}: malformed or unparsed story heading`);
  }
  return stories;
};

const parseIndex = (text, source) => {
  const rows = new Map();
  for (const line of text.split("\n")) {
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (!/^\d+$/.test(cells[0] ?? "") || !/^US-\d+[A-Z0-9]*$/.test(cells[1] ?? "")) continue;
    const id = cells[1];
    if (rows.has(id)) fail(`${source}: duplicate index row ${id}`);
    const dependencyCell = cells.at(-1);
    rows.set(id, {
      priority: Number(cells[0]),
      dependsOn: dependencyCell === "none" ? [] : dependencyCell.split(",").map((value) => value.trim()),
    });
  }
  return rows;
};

const allStories = [];
const ownedTexts = [];
const indexRows = new Map();
let branchName;

for (const set of sets) {
  const markdown = await read(set.directory, set.stories);
  const jsonText = await read(set.directory, "prd.json");
  const indexText = await read(set.directory, set.index);
  const markdownStories = parseMarkdownStories(markdown, `${set.directory}/${set.stories}`);
  const parsed = JSON.parse(jsonText);
  if (branchName !== undefined && branchName !== parsed.branchName) fail("plan branches differ");
  branchName = parsed.branchName;
  if (
    JSON.stringify(markdownStories) !==
    JSON.stringify(
      parsed.userStories.map(({ id, title, description, recipeIds, acceptanceCriteria }) => ({
        id,
        title,
        description,
        ...(recipeIds === undefined ? {} : { recipeIds }),
        acceptanceCriteria,
      })),
    )
  )
    fail(`${set.directory}: Markdown/JSON story text or order differs`);
  for (const story of parsed.userStories) {
    if (typeof story.passes !== "boolean") fail(`${story.id}: passes must be boolean`);
    if (initial && story.passes !== false) fail(`${story.id}: initial passes must be false`);
    if (!Array.isArray(story.dependsOn) || new Set(story.dependsOn).size !== story.dependsOn.length) {
      fail(`${story.id}: dependencies must be a unique array`);
    }
    allStories.push(story);
  }
  for (const [id, row] of parseIndex(indexText, `${set.directory}/${set.index}`)) {
    if (indexRows.has(id)) fail(`duplicate indexed story ${id}`);
    indexRows.set(id, row);
  }
  ownedTexts.push(markdown, jsonText, indexText);
}

for (const set of sets) {
  for (const file of ["spec-config-translation.md", "spec-lando3-compat.md", "lando3-gap-analysis.md"]) {
    if (await Bun.file(new URL(`${set.directory}/${file}`, root)).exists())
      ownedTexts.push(await read(set.directory, file));
  }
}

const byId = new Map();
const byPriority = new Map();
for (const story of allStories) {
  if (byId.has(story.id)) fail(`duplicate story id ${story.id}`);
  if (byPriority.has(story.priority)) fail(`duplicate priority ${story.priority}`);
  byId.set(story.id, story);
  byPriority.set(story.priority, story.id);
}

if (allStories.length === 0) fail("coordinated plan has no stories");
for (let priority = 1; priority <= allStories.length; priority += 1) {
  if (!byPriority.has(priority)) fail(`missing global priority ${priority}`);
}

for (const story of allStories) {
  const indexed = indexRows.get(story.id);
  if (!indexed) fail(`${story.id}: missing index row`);
  if (indexed.priority !== story.priority) fail(`${story.id}: index priority differs`);
  if (JSON.stringify(indexed.dependsOn) !== JSON.stringify(story.dependsOn)) {
    fail(`${story.id}: index dependencies differ`);
  }
  for (const dependency of story.dependsOn) {
    const predecessor = byId.get(dependency);
    if (!predecessor) fail(`${story.id}: unknown dependency ${dependency}`);
    if (predecessor.priority >= story.priority)
      fail(`${story.id}: dependency ${dependency} is not topological`);
    if (story.passes && !predecessor.passes) fail(`${story.id}: completed before ${dependency}`);
  }
}
if (indexRows.size !== allStories.length) fail("index/story cardinality differs");

const visiting = new Set();
const visited = new Set();
const visit = (id) => {
  if (visiting.has(id)) fail(`dependency cycle at ${id}`);
  if (visited.has(id)) return;
  visiting.add(id);
  for (const dependency of byId.get(id).dependsOn) visit(dependency);
  visiting.delete(id);
  visited.add(id);
};
for (const id of byId.keys()) visit(id);

const closure = byId.get("US-622B");
const dependedOnWithoutClosure = new Set(
  allStories.filter((story) => story.id !== closure.id).flatMap((story) => story.dependsOn),
);
const terminalLeaves = allStories
  .filter((story) => story.id !== closure.id && !dependedOnWithoutClosure.has(story.id))
  .map((story) => story.id)
  .sort();
if (JSON.stringify([...closure.dependsOn].sort()) !== JSON.stringify(terminalLeaves)) {
  fail(`US-622B must depend on every terminal leaf: ${terminalLeaves.join(", ")}`);
}

const buildConfig = await Bun.file(new URL("../core/build.config.ts", root)).text();
const recipeBlock = buildConfig.match(/bundledRecipes:\s*\[([\s\S]*?)\]/)?.[1];
if (!recipeBlock) fail("cannot locate bundledRecipes in core/build.config.ts");
const actualRecipeIds = [...recipeBlock.matchAll(/\bid:\s*"([^"]+)"/g)].map((match) => match[1]);
if (actualRecipeIds.length === 0) fail("bundledRecipes has no recipe ids");
const recipeStories = allStories.filter((story) => story.recipeIds !== undefined);
if (recipeStories.length === 0) fail("plan has no grouped recipe stories");
const plannedRecipeIds = recipeStories.flatMap((story) => {
  if (!Array.isArray(story.recipeIds) || story.recipeIds.length === 0) {
    fail(`${story.id}: recipeIds must be a nonempty array`);
  }
  return story.recipeIds;
});
if (new Set(plannedRecipeIds).size !== plannedRecipeIds.length) {
  fail("grouped recipe coverage contains duplicate ids");
}
if (JSON.stringify([...plannedRecipeIds].sort()) !== JSON.stringify([...actualRecipeIds].sort())) {
  fail("grouped recipe coverage differs from bundledRecipes");
}
const expectedRecipeGraph = {
  "US-609E7": ["US-609E6"],
  "US-609E8": ["US-609E7"],
  "US-609E": [...recipeStories.map((story) => story.id), "US-609E7", "US-609E8"],
};
for (const [id, dependencies] of Object.entries(expectedRecipeGraph)) {
  const story = byId.get(id);
  if (!story) fail(`missing recipe cutover story ${id}`);
  if (JSON.stringify([...story.dependsOn].sort()) !== JSON.stringify([...dependencies].sort())) {
    fail(`${id} must depend on exactly: ${dependencies.join(", ")}`);
  }
}

const joined = ownedTexts.join("\n");
for (const match of joined.matchAll(/US-\d+[A-Z0-9]*/g)) {
  if (!byId.has(match[0])) fail(`stale or unknown story reference ${match[0]}`);
}
for (const forbidden of [
  "—",
  "oldFragment",
  "oldDefaults",
  "version-probe",
  "version probe",
  "inspect `lando --version`",
  "every JSON criterion is byte-equal to Markdown, all `passes` values remain false",
]) {
  if (joined.includes(forbidden)) fail(`forbidden stale text: ${forbidden}`);
}

console.log(
  `PASS: ${allStories.length} stories; Markdown/JSON/index parity; unique sequential priorities; valid acyclic topological dependencies; terminal closure; ${actualRecipeIds.length}-recipe exact-once grouped coverage; no stale references`,
);
