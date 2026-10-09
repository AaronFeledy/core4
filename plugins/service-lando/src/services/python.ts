import { Schema } from "effect";

import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

import { serviceFeatureApply } from "./_feature-helpers.ts";
import { type LanguageFrameworkPreset, makeLanguageRuntime } from "./_language-runtime.ts";

export const SUPPORTED_PYTHON_VERSIONS = ["3.12"] as const;
export type SupportedPythonVersion = (typeof SUPPORTED_PYTHON_VERSIONS)[number];
const PYTHON_ARTIFACTS = Object.fromEntries(
  SUPPORTED_PYTHON_VERSIONS.map((version) => [version, `python:${version}-slim`]),
);

export const SUPPORTED_PYTHON_FRAMEWORKS = ["django", "fastapi", "flask", "none"] as const;
export type SupportedPythonFramework = (typeof SUPPORTED_PYTHON_FRAMEWORKS)[number];

export const PYTHON_FEATURE_ID = "service-lando.python" as const;
export const PYTHON_FEATURE_PRIORITY = 600;

const FRAMEWORK_PRESETS: Record<SupportedPythonFramework, LanguageFrameworkPreset> = {
  django: {
    port: 8000,
    defaultCommand: ["uvicorn", "--host", "0.0.0.0", "--port", "8000"],
    env: new Map([["DJANGO_SETTINGS_MODULE", "config.settings"]]),
  },
  fastapi: {
    port: 8000,
    defaultCommand: ["uvicorn", "--host", "0.0.0.0", "--port", "8000"],
    env: new Map(),
  },
  flask: {
    port: 5000,
    defaultCommand: ["gunicorn", "--bind", "0.0.0.0:5000"],
    env: new Map([["FLASK_APP", "app"]]),
  },
  none: {
    port: 8000,
    defaultCommand: null,
    env: new Map(),
  },
};

const PythonFeatureConfigSchema = Schema.Struct({
  framework: Schema.Literals([...SUPPORTED_PYTHON_FRAMEWORKS]),
  version: Schema.Literals([...SUPPORTED_PYTHON_VERSIONS]),
  port: Schema.Number,
  defaultCommand: Schema.optionalKey(Schema.Union([Schema.Null, Schema.Array(Schema.String)])),
});
type PythonFeatureConfig = typeof PythonFeatureConfigSchema.Type;
const configFor = (ctx: ServiceFeatureContext): PythonFeatureConfig => ctx.config as PythonFeatureConfig;

const runtime = makeLanguageRuntime({
  language: "python",
  displayName: "Python",
  versions: SUPPORTED_PYTHON_VERSIONS,
  artifacts: PYTHON_ARTIFACTS,
  artifactFor: (version) => `python:${version}-slim`,
  frameworks: SUPPORTED_PYTHON_FRAMEWORKS,
  presets: FRAMEWORK_PRESETS,
  baseEnv: { PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1" },
  mountExcludes: ["__pycache__"],
  mountRealization: "passthrough",
  includeWebrootInFeatureConfig: false,
  extensionKey: "lando-service-python",
  featureId: PYTHON_FEATURE_ID,
  priority: PYTHON_FEATURE_PRIORITY,
  featureSchema: PythonFeatureConfigSchema,
  configFor,
  applyFallback: "service-lando.python failed to apply",
  resolveFallback: (version) => `Failed to resolve python:${version}`,
});

export const pythonServiceFeature: ServiceFeatureDefinition = {
  ...runtime.serviceFeature,
  apply: serviceFeatureApply(PYTHON_FEATURE_ID, "service-lando.python failed to apply", (ctx) => {
    runtime.applyFeature(ctx);
    const { version } = configFor(ctx);
    const { image, build } = ctx.normalizedConfig;
    if (build !== undefined && "context" in build) return;
    if (image === undefined || image === PYTHON_ARTIFACTS[version]) {
      ctx.addBuildStep({
        id: "service-lando.python:uv",
        phase: "build",
        command: ["python", "-m", "pip", "install", "--no-cache-dir", "uv==0.12.24"],
        user: "root",
      });
    }
  }),
};
export const makePythonServiceType = runtime.makeServiceType;
export const python312ServiceType: ServiceType = makePythonServiceType("3.12");
