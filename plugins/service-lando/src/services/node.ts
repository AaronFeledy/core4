import { Schema } from "effect";
import { satisfies, subset, valid, validRange } from "semver";

import { causeMessage } from "@lando/sdk/errors";
import type { ServiceConfig } from "@lando/sdk/schema";
import type {
  ServiceFeatureContext,
  ServiceFeatureDefinition,
  ServiceType,
  ServiceTypeProjectFileInput,
} from "@lando/sdk/services";
import {
  ServiceConfigIssue,
  rootIdentity,
  serviceFeatureApply,
  serviceTypeResolve,
} from "./_feature-helpers.ts";

import { type PackageEntry, normalizeNpmGlobals, shellSingleQuote } from "./_package-specs.ts";
import { addServicePortEndpoints } from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";

export const SUPPORTED_NODE_MAJORS = [
  { major: 22, codename: "jod" },
  { major: 24, codename: "krypton", lts: true },
  { major: 26 },
] as const;

export type SupportedNodeMajor = (typeof SUPPORTED_NODE_MAJORS)[number]["major"];
export const SUPPORTED_NODE_VERSIONS = ["lts", "22", "24", "26"] as const;
export type SupportedNodeVersion = (typeof SUPPORTED_NODE_VERSIONS)[number];

const NODE_LTS_MAJOR = SUPPORTED_NODE_MAJORS.find((entry) => "lts" in entry && entry.lts)?.major ?? 24;

const NODE_ARTIFACTS: Readonly<Record<SupportedNodeVersion, string>> = Object.fromEntries([
  ["lts", `node:${NODE_LTS_MAJOR}`],
  ...SUPPORTED_NODE_MAJORS.map((entry) => [String(entry.major), `node:${entry.major}`] as const),
]) as Readonly<Record<SupportedNodeVersion, string>>;

const NODE_MAJOR_IDS = SUPPORTED_NODE_MAJORS.map((entry) => String(entry.major));
const NODE_CODENAMES = SUPPORTED_NODE_MAJORS.flatMap((entry) =>
  "codename" in entry && entry.codename !== undefined ? [entry.codename] : [],
);
const NVMRC_REMEDIATION = `Use a supported Node major (${NODE_MAJOR_IDS.join(", ")}), an LTS codename (${NODE_CODENAMES.join(", ")}), lts/*, or an exact pin of a supported major.`;

export const NODE_FEATURE_ID = "service-lando.node" as const;
export const NODE_FEATURE_PRIORITY = 600;
export const NODE_GLOBALS_STEP_ID = "service-lando.node:globals" as const;

// The kernel drops default-disposition signals to PID 1, so the idle process handles them itself.
const DEFAULT_COMMAND = [
  "node",
  "-e",
  'process.on("SIGTERM",()=>process.exit(0));process.on("SIGINT",()=>process.exit(0));setInterval(()=>{},2147483647);',
] as const;
const DEFAULT_PORT = 3000;

const NodeFeatureConfigSchema = Schema.Struct({
  version: Schema.String,
});
type NodeFeatureConfig = typeof NodeFeatureConfigSchema.Type;

const REMEDIATION_VERSION = (requested: string): string =>
  `Set type to one of: ${SUPPORTED_NODE_VERSIONS.map((v) => `node:${v}`).join(", ")} (got node:${requested}).`;

const PROJECT_FILE_LIMIT = 1_048_576;

export class NodeInferenceError extends Error {
  readonly remediation: string;

  constructor(message: string, remediation: string) {
    super(`${message} ${remediation}`);
    this.name = "NodeInferenceError";
    this.remediation = remediation;
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
    throw new NodeInferenceError(`Unsupported Node version "" in ${input.path}.`, NVMRC_REMEDIATION);
  }

  if (constraint === "lts" || constraint === "lts/*") {
    return majorSelection(NODE_LTS_MAJOR, input.path, constraint);
  }

  for (const entry of SUPPORTED_NODE_MAJORS) {
    const major = entry.major;
    const exact = new RegExp(`^v?${major}\\.(\\d+)\\.(\\d+)$`, "u").exec(constraint);
    const minor = new RegExp(`^v?${major}\\.(\\d+)$`, "u").exec(constraint);
    const isMajor = new RegExp(`^v?${major}$`, "u").test(constraint);
    const codename = "codename" in entry ? entry.codename : undefined;

    if (exact !== null) {
      const normalized = constraint.replace(/^v/u, "");
      if (valid(normalized) === null) {
        throw new NodeInferenceError(
          `Invalid Node version "${constraint}" in ${input.path}.`,
          exactPinRemediation,
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
    if (
      isMajor ||
      (codename !== undefined && (constraint === codename || constraint === `lts/${codename}`))
    ) {
      return majorSelection(major, input.path);
    }
  }

  throw new NodeInferenceError(
    `Unsupported Node version "${constraint}" in ${input.path}.`,
    NVMRC_REMEDIATION,
  );
};

const packageEngine = (
  input: ServiceTypeProjectFileInput & { readonly present: true },
): string | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.text);
  } catch (cause) {
    throw new NodeInferenceError(
      `Node inference could not parse ${input.path} as valid JSON: ${causeMessage(cause)}.`,
      "Fix package.json or remove bare type: node.",
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new NodeInferenceError(
      `${input.path} must contain a JSON object.`,
      "Fix package.json or remove bare type: node.",
    );
  }
  const engines = Reflect.get(parsed, "engines");
  if (engines === undefined) return undefined;
  if (engines === null || typeof engines !== "object" || Array.isArray(engines)) {
    throw new NodeInferenceError(
      `${input.path} engines must be an object.`,
      "Set engines.node to a valid semver range.",
    );
  }
  const node = Reflect.get(engines, "node");
  if (node === undefined) return undefined;
  if (typeof node !== "string") {
    throw new NodeInferenceError(
      `${input.path} engines.node must be a string.`,
      "Set engines.node to a valid semver range.",
    );
  }
  const constraint = node.trim();
  if (validRange(constraint) === null) {
    throw new NodeInferenceError(
      `${input.path} engines.node is not a valid semver range: "${constraint}".`,
      "Set engines.node to a valid semver range.",
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
  const lts = compatible.find((entry) => "lts" in entry && entry.lts);
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
        `${nvmrc.path} constraint "${selection.normalizedConstraint}" conflicts with package.json engines.node "${engine}".`,
        "Make both project files describe compatible Node versions.",
      );
    }
    return selection;
  }
  if (engine !== undefined) {
    const major = selectMajorForEngine(engine);
    if (major !== undefined) {
      return {
        artifact: `node:${major}`,
        normalizedConstraint: engine,
        sourcePath: packageJson?.path ?? "package.json",
      };
    }
    throw new NodeInferenceError(
      `package.json engines.node "${engine}" does not prove that a complete supported Node image channel (${NODE_MAJOR_IDS.join(", ")}) is compatible.`,
      exactPinRemediation,
    );
  }
  throw new NodeInferenceError(
    packageJson?.present === true
      ? "package.json has no Node constraint in engines.node."
      : "Node inference found neither .nvmrc nor package.json.",
    "Add .nvmrc or package.json engines.node, then retry.",
  );
};

const validateVersion = (
  declaredType: string | undefined,
  fallback: SupportedNodeVersion,
): SupportedNodeVersion => {
  if (declaredType === undefined) return fallback;
  if (!declaredType.startsWith("node:")) return fallback;
  const version = declaredType.slice("node:".length);
  if ((SUPPORTED_NODE_VERSIONS as ReadonlyArray<string>).includes(version)) {
    return version as SupportedNodeVersion;
  }
  throw new ServiceConfigIssue(
    ["type"],
    `Unsupported Node version "${version}".`,
    REMEDIATION_VERSION(version),
  );
};

const artifactFor = (version: string): string =>
  Object.hasOwn(NODE_ARTIFACTS, version)
    ? NODE_ARTIFACTS[version as SupportedNodeVersion]
    : `node:${version}`;

// Official Node images ship `yarn` as a Yarn 1 symlink; pnpm is absent.
// Node 26 drops both that symlink and Corepack. --force lets authored globals
// replace a Yarn 1 stub instead of failing EEXIST.
const nodeGlobalsCommandFor = (entries: ReadonlyArray<PackageEntry>): string =>
  [
    "set -eux",
    [
      "npm install -g --force --no-fund --no-audit",
      ...entries.map(([name, version]) => shellSingleQuote(`${name}@${version}`)),
    ].join(" "),
  ].join(" && ");

const applyNodeFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const { version } = ctx.config as NodeFeatureConfig;
  const port = service.port ?? DEFAULT_PORT;

  ctx.setArtifact({ kind: "ref", ref: service.image ?? artifactFor(version) });
  ctx.setCommand(service.command ?? [...DEFAULT_COMMAND]);
  ctx.addEnv("PORT", String(port));
  applyAuthoredProcessFields(ctx, ["user"]);

  addServicePortEndpoints(ctx, { port, protocol: "http" });

  applyAuthoredProcessFields(ctx, ["entrypoint"]);
  const globals = normalizeNpmGlobals(service.globals);
  if (globals.length > 0) {
    ctx.addBuildStep({
      id: NODE_GLOBALS_STEP_ID,
      phase: "build",
      command: nodeGlobalsCommandFor(globals),
      user: "root",
      buildKeyInputs: { globals },
    });
  }
};

export const nodeServiceFeature: ServiceFeatureDefinition = {
  id: NODE_FEATURE_ID,
  schema: NodeFeatureConfigSchema as Schema.Codec<unknown>,
  priority: NODE_FEATURE_PRIORITY,
  apply: serviceFeatureApply(NODE_FEATURE_ID, "service-lando.node failed to apply", applyNodeFeature),
};

const normalizedService = (service: ServiceConfig, resolvedVersion: string): ServiceConfig => ({
  ...service,
  type: `node:${resolvedVersion}`,
});

const makeNodeServiceType = (version: SupportedNodeVersion): ServiceType => ({
  id: `node:${version}`,
  name: `node:${version}`,
  base: "lando",
  versions: SUPPORTED_NODE_VERSIONS,
  artifacts: NODE_ARTIFACTS,
  identity: rootIdentity({ node: "/home/node" }),
  schema: Schema.Unknown,
  resolve: (input) =>
    serviceTypeResolve(`node:${version}`, `Failed to resolve node:${version}`, () => {
      const resolvedVersion = validateVersion(input.service.type, version);
      normalizeNpmGlobals(input.service.globals);

      return {
        base: "lando" as const,
        normalizedConfig: normalizedService(input.service, resolvedVersion),
        features: [
          { id: NODE_FEATURE_ID, config: { version: resolvedVersion } },
          {
            id: "lando.app-mount",
            config: { target: "/app" },
          },
        ],
      };
    }),
});

export const nodeLtsServiceType: ServiceType = makeNodeServiceType("lts");
export const node22ServiceType: ServiceType = makeNodeServiceType("22");
export const node24ServiceType: ServiceType = makeNodeServiceType("24");
export const node26ServiceType: ServiceType = makeNodeServiceType("26");

export const nodeServiceType: ServiceType = {
  id: "node",
  name: "node",
  base: "lando",
  identity: rootIdentity({ node: "/home/node" }),
  schema: Schema.Unknown,
  projectFiles: (service) => {
    const packageRoot = service.packageRoot ?? ".";
    const prefix = packageRoot === "." ? "" : `${packageRoot}/`;
    return [
      { path: `${prefix}.nvmrc`, maxBytes: PROJECT_FILE_LIMIT },
      { path: `${prefix}package.json`, maxBytes: PROJECT_FILE_LIMIT },
    ];
  },
  resolve: (input) =>
    serviceTypeResolve("node", "Failed to infer a Node version.", () => {
      const inference = resolveNodeInference(input.projectFiles ?? []);
      const resolvedVersion = inference.artifact.slice("node:".length);
      normalizeNpmGlobals(input.service.globals);
      const files = (input.projectFiles ?? []).map((file) => ({
        path: file.path,
        present: file.present,
        ...(file.present ? { sha256: file.sha256 } : {}),
      }));
      return {
        base: "lando" as const,
        normalizedConfig: normalizedService(input.service, resolvedVersion),
        features: [
          { id: NODE_FEATURE_ID, config: { version: resolvedVersion } },
          { id: "lando.app-mount", config: { target: "/app" } },
        ],
        metadata: {
          node: {
            sourcePath: inference.sourcePath,
            normalizedConstraint: inference.normalizedConstraint,
            artifact: inference.artifact,
            files,
          },
        },
      };
    }),
};
