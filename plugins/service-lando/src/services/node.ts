import { Effect, Schema } from "effect";
import { satisfies, subset, valid, validRange } from "semver";

import { ServiceFeatureError, ServiceTypeError } from "@lando/sdk/errors";
import { AbsolutePath, PortablePath, type ServiceConfig } from "@lando/sdk/schema";
import type {
  ServiceFeatureContext,
  ServiceFeatureDefinition,
  ServiceType,
  ServiceTypeProjectFileInput,
} from "@lando/sdk/services";

import { addServicePortEndpoints } from "./_port-helpers.ts";

export const SUPPORTED_NODE_VERSIONS = ["lts", "22"] as const;
export type SupportedNodeVersion = (typeof SUPPORTED_NODE_VERSIONS)[number];

export const NODE_FEATURE_ID = "service-lando.node" as const;
export const NODE_FEATURE_PRIORITY = 600;

const APP_MOUNT_TARGET = PortablePath.make("/app");
const DEFAULT_COMMAND = ["sh", "-c", "tail -f /dev/null"] as const;
const DEFAULT_PORT = 3000;

const NodeFeatureConfigSchema = Schema.Struct({
  version: Schema.String,
});
type NodeFeatureConfig = typeof NodeFeatureConfigSchema.Type;

const REMEDIATION_VERSION = (requested: string): string =>
  `Set type to one of: ${SUPPORTED_NODE_VERSIONS.map((v) => `node:${v}`).join(", ")} (got node:${requested}).`;

const NODE_MAJOR = 22;
const NODE_LTS_CODENAME = "jod";
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

const parseNvmrc = (input: ServiceTypeProjectFileInput & { readonly present: true }): ParsedNvmrc => {
  const constraint = input.text.trim().toLowerCase();
  const major = new RegExp(`^v?${NODE_MAJOR}$`, "u");
  const minor = new RegExp(`^v?${NODE_MAJOR}\\.(\\d+)$`, "u").exec(constraint);
  const exact = new RegExp(`^v?${NODE_MAJOR}\\.(\\d+)\\.(\\d+)$`, "u").exec(constraint);

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
  if (minor !== null) {
    const normalized = `${NODE_MAJOR}.${minor[1]}`;
    return {
      artifact: `node:${normalized}`,
      normalizedConstraint: normalized,
      sourcePath: input.path,
      range: `>=${normalized}.0 <${NODE_MAJOR}.${Number(minor[1]) + 1}.0`,
      exactVersion: undefined,
    };
  }
  if (
    major.test(constraint) ||
    constraint === NODE_LTS_CODENAME ||
    constraint === `lts/${NODE_LTS_CODENAME}`
  ) {
    return {
      artifact: `node:${NODE_MAJOR}`,
      normalizedConstraint: String(NODE_MAJOR),
      sourcePath: input.path,
      range: `>=${NODE_MAJOR}.0.0 <${NODE_MAJOR + 1}.0.0`,
      exactVersion: undefined,
    };
  }
  if (constraint === "lts/*") {
    return {
      artifact: "node:lts",
      normalizedConstraint: constraint,
      sourcePath: input.path,
      range: "*",
      exactVersion: undefined,
    };
  }
  throw new NodeInferenceError(
    `Unsupported Node version "${constraint}" in ${input.path}.`,
    `Use Node ${NODE_MAJOR}, ${NODE_LTS_CODENAME}, lts/*, or an exact Node ${NODE_MAJOR} pin.`,
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
      `Node inference could not parse ${input.path} as valid JSON: ${cause instanceof Error ? cause.message : String(cause)}.`,
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

export const resolveNodeInference = (
  inputs: ReadonlyArray<ServiceTypeProjectFileInput>,
): NodeInferenceSelection => {
  const nvmrc = inputs.find((input) => input.path.endsWith("/.nvmrc") || input.path === ".nvmrc");
  const packageJson = inputs.find(
    (input) => input.path.endsWith("/package.json") || input.path === "package.json",
  );
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
    const supportedRange = `>=${NODE_MAJOR}.0.0 <${NODE_MAJOR + 1}.0.0`;
    if (subset(supportedRange, engine)) {
      return {
        artifact: `node:${NODE_MAJOR}`,
        normalizedConstraint: engine,
        sourcePath: packageJson?.path ?? "package.json",
      };
    }
    throw new NodeInferenceError(
      `package.json engines.node "${engine}" does not prove that the complete Node ${NODE_MAJOR} image channel is compatible.`,
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
  throw new Error(`Unsupported Node version "${version}". ${REMEDIATION_VERSION(version)}`);
};

const configFor = (ctx: ServiceFeatureContext): NodeFeatureConfig => ctx.config as NodeFeatureConfig;

const applyNodeFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const { version } = configFor(ctx);
  const serviceType = `node:${version}`;
  const port = service.port ?? DEFAULT_PORT;
  const appMount = {
    source: AbsolutePath.make(ctx.appRoot),
    target: APP_MOUNT_TARGET,
    readOnly: false,
    excludes: [],
    includes: [],
    realization: "passthrough" as const,
  };
  const bindMount = {
    type: "bind" as const,
    source: ctx.appRoot,
    target: APP_MOUNT_TARGET,
    readOnly: false,
    realization: "passthrough" as const,
  };

  ctx.setArtifact({ kind: "ref", ref: service.image ?? serviceType });
  ctx.setCommand(service.command ?? [...DEFAULT_COMMAND]);
  ctx.setWorkingDirectory(service.workingDirectory ?? APP_MOUNT_TARGET);
  if (service.user !== undefined) ctx.setUser(service.user);
  ctx.setAppMount(appMount);
  ctx.addMount(bindMount);

  addServicePortEndpoints(ctx, { port, protocol: "http" });

  if (service.entrypoint !== undefined) ctx.setEntrypoint(service.entrypoint);
};

export const nodeServiceFeature: ServiceFeatureDefinition = {
  id: NODE_FEATURE_ID,
  schema: NodeFeatureConfigSchema as Schema.Schema<unknown>,
  priority: NODE_FEATURE_PRIORITY,
  apply: (ctx) =>
    Effect.try({
      try: () => applyNodeFeature(ctx),
      catch: (cause) =>
        new ServiceFeatureError({
          message: cause instanceof Error ? cause.message : "service-lando.node failed to apply",
          feature: NODE_FEATURE_ID,
          cause,
        }),
    }),
};

const normalizedService = (service: ServiceConfig, resolvedVersion: string): ServiceConfig => ({
  ...service,
  type: `node:${resolvedVersion}`,
});

const makeNodeServiceType = (version: SupportedNodeVersion): ServiceType => ({
  id: `node:${version}`,
  name: `node:${version}`,
  base: "lando",
  schema: Schema.Unknown,
  resolve: (input) =>
    Effect.try({
      try: () => {
        const resolvedVersion = validateVersion(input.service.type, version);

        return {
          base: "lando" as const,
          normalizedConfig: normalizedService(input.service, resolvedVersion),
          features: [
            { id: NODE_FEATURE_ID, config: { version: resolvedVersion } },
            {
              id: "lando.env",
              config: { appPaths: { appRoot: "/app", projectMount: "/app" } },
            },
          ],
        };
      },
      catch: (cause) =>
        new ServiceTypeError({
          message: cause instanceof Error ? cause.message : `Failed to resolve node:${version}`,
          serviceType: `node:${version}`,
          cause,
        }),
    }),
});

export const nodeLtsServiceType: ServiceType = makeNodeServiceType("lts");
export const node22ServiceType: ServiceType = makeNodeServiceType("22");

export const nodeServiceType: ServiceType = {
  id: "node",
  name: "node",
  base: "lando",
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
    Effect.try({
      try: () => {
        const inference = resolveNodeInference(input.projectFiles ?? []);
        const resolvedVersion = inference.artifact.slice("node:".length);
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
            { id: "lando.env", config: { appPaths: { appRoot: "/app", projectMount: "/app" } } },
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
      },
      catch: (cause) =>
        new ServiceTypeError({
          message: cause instanceof Error ? cause.message : "Failed to infer a Node version.",
          serviceType: "node",
          cause,
        }),
    }),
};
