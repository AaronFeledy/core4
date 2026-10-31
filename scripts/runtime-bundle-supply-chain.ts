export const RUNTIME_BUNDLE_ACTION_PINS = {
  checkout: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  downloadArtifact: "actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333",
  setupBun: "oven-sh/setup-bun@735343b667d3e6f658f44d0eca948eb6282f2b76",
  setupNode: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
  uploadArtifact: "actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f",
  cache: "actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
} as const;

/** Inputs that can change the Linux archive, including the bundled entry's local module graph. */
export const LINUX_RUNTIME_BUNDLE_CACHE_INPUTS = [
  "plugins/provider-lando/runtime-bundle-sources.json",
  "scripts/assemble-runtime-bundle.ts",
  "scripts/build-runtime-bundle.ts",
  "scripts/check-runtime-bundle-manifest.ts",
  "scripts/linux-podman-source-build.ts",
  "scripts/linux-podman-portability.ts",
  "scripts/runtime-bundle-sources.ts",
  "scripts/runtime-bundle-fetch.ts",
  "scripts/runtime-bundle-licenses.ts",
  "scripts/linux-runtime-bundle-builder.ts",
  "scripts/runtime-bundle-builder/**",
  "scripts/runtime-bundle-supply-chain.ts",
  "scripts/patches/netavark-v2.0.0-systemd-user-bus.patch",
  ".bun-version",
  "bun.lock",
  "package.json",
  "tsconfig.json",
  "tsconfig.base.json",
  "scripts/tsconfig.json",
] as const;

export const linuxRuntimeBundleCacheHashFiles = (): string =>
  `hashFiles(${LINUX_RUNTIME_BUNDLE_CACHE_INPUTS.map((path) => `'${path}'`).join(", ")})`;
