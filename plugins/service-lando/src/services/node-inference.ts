import type { ServiceTypeProjectFileInput } from "@lando/sdk/services";
import { satisfies, subset, valid, validRange } from "semver";
import { ServiceConfigIssue } from "./_feature-helpers.ts";
import { NODE_LTS_MAJOR, SUPPORTED_NODE_MAJORS, type SupportedNodeMajor } from "./node-versions.ts";

const NODE_MAJOR_IDS = SUPPORTED_NODE_MAJORS.map((entry) => String(entry.major));
const NODE_CODENAMES = SUPPORTED_NODE_MAJORS.flatMap((entry) =>
  entry.codename === null ? [] : [entry.codename],
);
const NODE_LTS_MAJORS = SUPPORTED_NODE_MAJORS.filter((entry) => entry.lts !== null)
  .map((entry) => entry.major)
  .sort((left, right) => left - right);
const NODE_LTS_OFFSETS = Array.from(
  { length: Math.max(NODE_LTS_MAJORS.length - 1, 0) },
  (_, index) => `lts/-${index + 1}`,
);
const NVMRC_REMEDIATION = [
  `Use a supported Node major (${NODE_MAJOR_IDS.join(", ")}),`,
  `an LTS codename (${NODE_CODENAMES.join(", ")}),`,
  ...(NODE_LTS_OFFSETS.length > 0 ? [`${NODE_LTS_OFFSETS.join(", ")},`] : []),
  "lts/*, or an exact pin of a supported major.",
].join(" ");

export class NodeInferenceError extends ServiceConfigIssue {
  constructor(
    message: string,
    remediation: string,
    projectFile?: string,
    projectFileSourcePath?: ReadonlyArray<string | number>,
  ) {
    super([], message, {
      suggestion: remediation,
      ...(projectFile === undefined ? {} : { projectFile }),
      ...(projectFileSourcePath === undefined ? {} : { projectFileSourcePath }),
    });
    this.name = "NodeInferenceError";
  }
}

type NodeInferenceSelection = {
  readonly artifact: string;
  readonly normalizedConstraint: string;
  readonly sourcePath: string;
};

type ParsedNvmrc = NodeInferenceSelection & {
  readonly range: string | undefined;
  readonly exactVersion: string | undefined;
};

const exactPinRemediation = "Add an exact pin in .nvmrc, or a channel-preserving Node pin, then retry.";

const majorSelection = (
  major: number,
  sourcePath: string,
  normalizedConstraint: string = String(major),
): ParsedNvmrc => ({
  artifact: `node:${major}`,
  normalizedConstraint,
  sourcePath,
  range: String(major),
  exactVersion: undefined,
});

const parseNvmrc = (input: ServiceTypeProjectFileInput & { readonly present: true }): ParsedNvmrc => {
  const constraint = input.text
    .split(/\r?\n/u)
    .map((line) => line.replace(/#.*$/u, "").trim().toLowerCase())
    .find((line) => line.length > 0);
  if (constraint === undefined) {
    throw new NodeInferenceError('Unsupported Node version "".', NVMRC_REMEDIATION, input.path);
  }

  if (constraint === "lts" || constraint === "lts/*") {
    return majorSelection(NODE_LTS_MAJOR, input.path, constraint);
  }

  const ltsOffset = /^lts\/-(\d+)$/u.exec(constraint);
  if (ltsOffset !== null) {
    const offset = Number(ltsOffset[1]);
    const major = NODE_LTS_MAJORS[NODE_LTS_MAJORS.length - 1 - offset];
    if (major === undefined) {
      throw new NodeInferenceError(
        `Unsupported Node version ${JSON.stringify(constraint)}.`,
        NVMRC_REMEDIATION,
        input.path,
      );
    }
    return majorSelection(major, input.path, constraint);
  }

  for (const entry of SUPPORTED_NODE_MAJORS) {
    const major = entry.major;
    const exact = new RegExp(`^v?${major}\\.(\\d+)\\.(\\d+)$`, "u").exec(constraint);
    const minor = new RegExp(`^v?${major}\\.(\\d+)$`, "u").exec(constraint);
    const isMajor = new RegExp(`^v?${major}$`, "u").test(constraint);
    const codename = entry.codename;

    if (exact !== null) {
      const normalized = constraint.replace(/^v/u, "");
      if (valid(normalized) === null) {
        throw new NodeInferenceError(
          `Invalid Node version ${JSON.stringify(constraint)}.`,
          exactPinRemediation,
          input.path,
        );
      }
      return {
        artifact: `node:${normalized}`,
        normalizedConstraint: normalized,
        sourcePath: input.path,
        range: undefined,
        exactVersion: normalized,
      };
    }
    if (minor !== null && valid(`${major}.${minor[1]}.0`) !== null) {
      const normalized = `${major}.${minor[1]}`;
      return {
        artifact: `node:${normalized}`,
        normalizedConstraint: normalized,
        sourcePath: input.path,
        range: normalized,
        exactVersion: undefined,
      };
    }
    if (isMajor || (codename !== null && (constraint === codename || constraint === `lts/${codename}`))) {
      return majorSelection(major, input.path);
    }
  }

  throw new NodeInferenceError(
    `Unsupported Node version ${JSON.stringify(constraint)}.`,
    NVMRC_REMEDIATION,
    input.path,
  );
};

export const readPackageJson = (
  input: ServiceTypeProjectFileInput & { readonly present: true },
): Readonly<Record<string, unknown>> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new NodeInferenceError("Expected valid JSON.", "Fix the manifest's JSON syntax.", input.path);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new NodeInferenceError(
      "Expected a JSON object.",
      "Use a JSON object for the manifest.",
      input.path,
    );
  }
  return Object.fromEntries(Object.entries(parsed));
};

const packageEngine = (
  input: ServiceTypeProjectFileInput & { readonly present: true },
): string | undefined => {
  const parsed = readPackageJson(input);
  const engines = Reflect.get(parsed, "engines");
  if (engines === undefined) return undefined;
  if (engines === null || typeof engines !== "object" || Array.isArray(engines)) {
    throw new NodeInferenceError(
      "Expected an object for engine constraints.",
      "Use an object with a node entry containing a semver range.",
      input.path,
      ["engines"],
    );
  }
  const node = Reflect.get(engines, "node");
  if (node === undefined) return undefined;
  if (typeof node !== "string") {
    throw new NodeInferenceError(
      "Expected a Node version range as a string.",
      'Use a semver range such as "^22".',
      input.path,
      ["engines", "node"],
    );
  }
  const constraint = node.trim();
  if (validRange(constraint) === null) {
    throw new NodeInferenceError(
      "Expected a valid Node semver range.",
      'Use a semver range such as "^22".',
      input.path,
      ["engines", "node"],
    );
  }
  return constraint;
};

const compatibleWithEngine = (selection: ParsedNvmrc, engine: string): boolean => {
  if (selection.exactVersion !== undefined) return satisfies(selection.exactVersion, engine);
  if (selection.range === undefined) return false;
  return subset(selection.range, engine);
};

const selectMajorForEngine = (engine: string): SupportedNodeMajor | undefined => {
  const compatible = SUPPORTED_NODE_MAJORS.filter((entry) => subset(String(entry.major), engine));
  if (compatible.length === 0) return undefined;
  const lts = compatible.find((entry) => entry.major === NODE_LTS_MAJOR);
  return (lts ?? compatible.at(-1))?.major;
};

export const resolveNodeInference = (
  inputs: ReadonlyArray<ServiceTypeProjectFileInput>,
): NodeInferenceSelection => {
  const nvmrc = inputs.find((input) => /(?:^|[/\\])\.nvmrc$/u.test(input.path));
  const packageJson = inputs.find((input) => /(?:^|[/\\])package\.json$/u.test(input.path));
  const engine = packageJson?.present === true ? packageEngine(packageJson) : undefined;

  if (nvmrc?.present === true) {
    const selection = parseNvmrc(nvmrc);
    if (engine !== undefined && !compatibleWithEngine(selection, engine)) {
      throw new NodeInferenceError(
        `Node constraint ${JSON.stringify(selection.normalizedConstraint)} conflicts with package.json engines.node ${JSON.stringify(engine)}.`,
        "Make both project files describe compatible Node versions.",
        nvmrc.path,
      );
    }
    return selection;
  }
  if (packageJson?.present === true && engine !== undefined) {
    const major = selectMajorForEngine(engine);
    if (major !== undefined) {
      return {
        artifact: `node:${major}`,
        normalizedConstraint: engine,
        sourcePath: packageJson.path,
      };
    }
    throw new NodeInferenceError(
      `The Node range ${JSON.stringify(engine)} does not prove that a complete supported Node image channel (${NODE_MAJOR_IDS.join(", ")}) is compatible.`,
      exactPinRemediation,
      packageJson.path,
      ["engines", "node"],
    );
  }
  throw new NodeInferenceError(
    packageJson?.present === true
      ? "Node inference found no .nvmrc and package.json declares no engines.node."
      : "Node inference found neither .nvmrc nor package.json.",
    "Add .nvmrc or package.json engines.node, then retry.",
  );
};
