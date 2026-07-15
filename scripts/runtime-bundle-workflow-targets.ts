// Podman 6 drops Intel Mac support, so darwin-x64 is neither a runtime-bundle
// target nor a published asset. These match the four shipped runtime host keys.
export const RUNTIME_BUNDLE_PUBLISH_TARGET_KEYS = [
  "linux-x64",
  "linux-arm64",
  "darwin-arm64",
  "win32-x64",
] as const;
