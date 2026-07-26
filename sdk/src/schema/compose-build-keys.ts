// ==== Compose build-key inventory (SPEC: COMPOSE-02 US-471) ====

export const COMPOSE_BUILD_NORMALIZED_KEYS = [
  "args",
  "context",
  "dockerfile",
  "dockerfile_inline",
  "target",
] as const;

export const COMPOSE_BUILD_REJECTED_LITERAL_KEYS = [
  "additional_contexts",
  "cache_from",
  "cache_to",
  "entitlements",
  "extra_hosts",
  "isolation",
  "labels",
  "network",
  "no_cache",
  "no_cache_filter",
  "platforms",
  "privileged",
  "provenance",
  "pull",
  "sbom",
  "secrets",
  "shm_size",
  "ssh",
  "tags",
  "ulimits",
] as const;

export const COMPOSE_BUILD_EXTENSION_KEY_PREFIX = "x-" as const;
