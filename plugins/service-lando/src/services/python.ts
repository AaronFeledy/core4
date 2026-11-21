import { posix } from "node:path";
import { type ServiceConfig, canonicalMountEntry, sameImageReference } from "@lando/sdk/schema";
import type { ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
import { Effect, Schema } from "effect";

import { serviceFeatureApply } from "./_feature-helpers.ts";
import { type LanguageFrameworkPreset, makeLanguageRuntime } from "./_language-runtime.ts";
import { appMountTarget } from "./_volume-helpers.ts";
import { PYTHON_PREPARE_SCRIPT, PYTHON_UV_PIN } from "./python-dependency-environment.ts";
import { pythonServiceLaunchers } from "./python-local-launcher.ts";

export const SUPPORTED_PYTHON_VERSIONS = ["3.12"] as const;
export type SupportedPythonVersion = (typeof SUPPORTED_PYTHON_VERSIONS)[number];
const PYTHON_ARTIFACTS = Object.fromEntries(
  SUPPORTED_PYTHON_VERSIONS.map((version) => [version, `python:${version}-slim`]),
);

// Debian's login profile resets PATH, so recover the shell's original value in profile.d.
const UV_ARTIFACT_SCRIPT = `set -eu
requirements=$(mktemp)
trap 'rm -f "$requirements"' EXIT
printf '%s\\n' 'uv==${PYTHON_UV_PIN.version} ${PYTHON_UV_PIN.hashes.map((hash) => `--hash=sha256:${hash}`).join(" ")}' > "$requirements"
/usr/local/bin/python -m pip install --no-cache-dir --only-binary=:all: --require-hashes -r "$requirements"
cat > /etc/profile.d/lando-python-venv.sh <<'EOF'
lando_initial_path=$(/bin/grep -azm1 '^PATH=' "/proc/$$/environ" 2>/dev/null | /usr/bin/tr -d '\\000'; /usr/bin/printf '.')
case "$lando_initial_path" in
  PATH=*) lando_initial_path=\${lando_initial_path%.}; export PATH="\${lando_initial_path#PATH=}" ;;
esac
unset lando_initial_path
EOF`;

export const SUPPORTED_PYTHON_FRAMEWORKS = ["django", "fastapi", "flask", "none"] as const;
export type SupportedPythonFramework = (typeof SUPPORTED_PYTHON_FRAMEWORKS)[number];

export const PYTHON_FEATURE_ID = "service-lando.python" as const;
export const PYTHON_FEATURE_PRIORITY = 600;

export const FRAMEWORK_PRESETS: Readonly<Record<SupportedPythonFramework, LanguageFrameworkPreset>> = {
  django: {
    port: 8000,
    daemon: "Django",
    variables: ["PORT"],
    when: "framework: django",
    env: new Map([["DJANGO_SETTINGS_MODULE", "config.settings"]]),
  },
  fastapi: {
    port: 8000,
    daemon: "FastAPI",
    variables: ["PORT", "UVICORN_PORT"],
    hostDefaults: { UVICORN_HOST: "0.0.0.0" },
    when: "framework: fastapi",
  },
  flask: {
    port: 5000,
    daemon: "Flask",
    variables: ["PORT", "FLASK_RUN_PORT"],
    hostDefaults: { FLASK_RUN_HOST: "0.0.0.0" },
    when: "framework: flask",
    env: new Map([["FLASK_APP", "app"]]),
  },
  none: { port: 8000, daemon: "Python", variables: ["PORT"], when: "framework omitted or none" },
};
export const PYTHON_LISTENERS = FRAMEWORK_PRESETS;

const PythonFeatureConfigSchema = Schema.Struct({
  framework: Schema.Literals([...SUPPORTED_PYTHON_FRAMEWORKS]),
  version: Schema.Literals([...SUPPORTED_PYTHON_VERSIONS]),
  port: Schema.Number,
});
type PythonFeatureConfig = typeof PythonFeatureConfigSchema.Type;
const configFor = (ctx: { readonly config: Readonly<Record<string, unknown>> }): PythonFeatureConfig =>
  ctx.config as PythonFeatureConfig;

const runtime = makeLanguageRuntime({
  language: "python",
  displayName: "Python",
  versions: SUPPORTED_PYTHON_VERSIONS,
  artifacts: PYTHON_ARTIFACTS,
  artifactFor: (version) => `python:${version}-slim`,
  frameworks: SUPPORTED_PYTHON_FRAMEWORKS,
  presets: FRAMEWORK_PRESETS,
  baseEnv: { PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1" },
  mountExcludes: ["__pycache__", ".venv"],
  includeWebrootInFeatureConfig: false,
  extensionKey: "lando-service-python",
  featureId: PYTHON_FEATURE_ID,
  priority: PYTHON_FEATURE_PRIORITY,
  featureSchema: PythonFeatureConfigSchema,
  configFor,
  applyFallback: "service-lando.python failed to apply",
  resolveFallback: (version) => `Failed to resolve python:${version}`,
});

// The planner can stamp the catalog image before resolve. An additive build
// keeps that image; a replacement Compose build owns the toolchain instead.
const ownsPythonToolchain = (
  { image, build }: Pick<ServiceConfig, "image" | "build">,
  version: SupportedPythonVersion,
) =>
  (build === undefined || !("context" in build)) &&
  (image === undefined || sameImageReference(image, PYTHON_ARTIFACTS[version] ?? ""));

export const pythonServiceFeature: ServiceFeatureDefinition = {
  ...runtime.serviceFeature,
  apply: serviceFeatureApply(PYTHON_FEATURE_ID, "service-lando.python failed to apply", (ctx) => {
    runtime.applyFeature(ctx);
    const { version } = configFor(ctx);
    if (!ownsPythonToolchain(ctx.normalizedConfig, version)) return;
    const { appMount } = ctx.normalizedConfig;
    ctx.addBuildStep({
      id: "service-lando.python:uv",
      phase: "build",
      command: ["sh", "-c", UV_ARTIFACT_SCRIPT],
      user: "root",
    });

    if (appMount === false || appMount?.includes?.some((entry) => canonicalMountEntry(entry) === ".venv"))
      return;
    const venv = posix.join(appMountTarget(appMount), ".venv");
    if (venv.includes(":")) return;
    ctx.addDependencyEnvironment({
      kind: "python",
      target: venv,
      identity: { python: version },
      prepare: ["/bin/sh", "-c", PYTHON_PREPARE_SCRIPT, "lando-python-prepare", venv, PYTHON_UV_PIN.version],
      activation: {
        VIRTUAL_ENV: venv,
        PATH: `${venv}/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin`,
      },
      cache: { name: "uv", target: "/var/lib/lando/uv-cache", variable: "UV_CACHE_DIR" },
      inputs: "requirements.txt",
    });
  }),
};
export const makePythonServiceType = (version: SupportedPythonVersion): ServiceType => {
  const serviceType = runtime.makeServiceType(version);
  return {
    ...serviceType,
    resolve: (input) =>
      Effect.map(serviceType.resolve(input), (resolution) =>
        ownsPythonToolchain(resolution.normalizedConfig, version)
          ? { ...resolution, launchers: pythonServiceLaunchers }
          : resolution,
      ),
  };
};
export const python312ServiceType: ServiceType = makePythonServiceType("3.12");
