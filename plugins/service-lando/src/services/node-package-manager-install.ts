import { ServiceBuildAcquisition, type ServiceBuildStepIntent } from "@lando/sdk/services";
import { Schema } from "effect";
import { NodeInferenceError } from "./node-inference.ts";
import {
  NODE_PACKAGE_MANAGER_STEP_ID,
  type NodePackageManagerConfig,
  type NodePackageManagerSelection,
} from "./node-package-manager.ts";

export const validatePackageManagerDistribution = (selection: NodePackageManagerSelection): void => {
  const [major, minor, patch] = selection.version.split(/[.-]/u).map(Number);
  if (selection.name === "yarn" && major === 2 && (Number(minor) < 4 || (minor === 4 && patch === 0))) {
    throw new NodeInferenceError(
      `Yarn ${selection.version} predates the supported npm CLI distribution.`,
      "Upgrade Yarn to 2.4.1 or newer, or use an explicit Node type with a custom image.",
      selection.sourcePath,
      selection.sourceField.split("."),
    );
  }
};

const publishScript = [
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  "const [root, manager, family, version, env] = process.argv.slice(1);",
  'const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));',
  'if (pkg.name !== manager || pkg.version !== version) throw new Error("Unexpected package identity");',
  String.raw`const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";`,
  'const binaries = family === "pnpm" ? ["pnpm", "pnpx"] : ["yarn", "yarnpkg"];',
  "for (const binary of binaries) {",
  "  const declared = pkg.bin?.[binary];",
  '  if (typeof declared !== "string") throw new Error("Missing package bin: " + binary);',
  "  const entry = path.resolve(root, declared);",
  '  if (!entry.startsWith(root + "/") || fs.realpathSync(entry) !== entry || !fs.statSync(entry).isFile()) throw new Error("Invalid package bin: " + binary);',
  '  const target = "/usr/local/bin/" + binary;',
  '  const berry = manager === "@yarnpkg/cli-dist" ? "unset COREPACK_ROOT\\nexport YARN_YARN_PATH=" + quote(path.join(root, "bin/yarn.js")) + "\\n" : "";',
  "  fs.rmSync(target, { force: true });",
  String.raw`  fs.writeFileSync(target, "#!/bin/sh\n" + env + berry + "exec /usr/local/bin/node " + quote(entry) + " \"$@\"\n", { flag: "wx", mode: 0o755 });`,
  "}",
  'const smoke = require("node:child_process").spawnSync("/usr/local/bin/" + family, ["--version"], { cwd: "/", stdio: "inherit" });',
  "if (smoke.error) throw smoke.error;",
  "process.exitCode = smoke.status ?? 1;",
].join(" ");

export const packageManagerBuildStep = (selection: NodePackageManagerConfig): ServiceBuildStepIntent => {
  const { name, version, launcher } = selection;
  const major = Number(version.split(".")[0]);
  const berry = name === "yarn" && major >= 2;
  const npmName = berry ? "@yarnpkg/cli-dist" : name;
  const destination = `/usr/local/lib/lando/package-managers/${name}/${version}`;
  const [algorithm, hex] = selection.integrity?.split(".") ?? [];
  const acquisition = Schema.decodeUnknownSync(ServiceBuildAcquisition)({
    kind: "npm",
    name: npmName,
    version,
    contextName: "node-package-manager",
    destination,
    ...(selection.integrity === undefined
      ? {}
      : { integrity: { algorithm, hex, ...(berry ? { file: "bin/yarn.js" } : {}) } }),
  });
  const exports =
    name === "yarn"
      ? berry
        ? "export YARN_IGNORE_PATH=1"
        : "export YARN_IGNORE_PATH=1 SKIP_YARN_COREPACK_CHECK=1"
      : major >= 11
        ? "export pnpm_config_pm_on_fail=ignore"
        : "export npm_config_manage_package_manager_versions=false npm_config_package_manager_strict=false npm_config_package_manager_strict_version=false";
  const env = `${exports}; `;
  return {
    id: NODE_PACKAGE_MANAGER_STEP_ID,
    phase: "build",
    user: "root",
    acquisitions: [acquisition],
    buildKeyInputs: { launcher, sourcePolicy: "npm-configured-registry-exact-v1" },
    command: [
      "/usr/local/bin/node",
      "-e",
      publishScript,
      `${destination}/package`,
      npmName,
      name,
      version,
      env,
    ],
  };
};
