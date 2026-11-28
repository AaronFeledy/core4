import {
  ELASTICSEARCH_DEFAULT_IMAGE,
  NGINX_DEFAULT_IMAGE,
  PHP_VIA_MODES,
  SUPPORTED_PHP_VERSIONS,
  VARNISH_IMAGES,
  phpImageFor,
} from "@lando/service-lando/services/default-images";
import nodeReleases from "../plugins/service-lando/node/releases.json" with { type: "json" };

const identityImages = [
  ...SUPPORTED_PHP_VERSIONS.flatMap((version) => PHP_VIA_MODES.map((via) => phpImageFor(version, via))),
  ...Object.values(VARNISH_IMAGES),
].map((image) => `docker.io/library/${image}`);

const commonImages = [
  "docker.io/library/alpine:3.21",
  // Read the release pin rather than loading the service plugin during workflow codegen.
  ...nodeReleases.releases.map(({ major }) => `docker.io/library/node:${major}`),
  "docker.io/library/node:22-alpine",
  "docker.io/library/adminer:6",
  "quay.io/keycloak/keycloak:26.8",
  "docker.io/library/postgres:16",
  "docker.io/library/postgres:16-alpine",
  "docker.io/library/postgres:18",
  "docker.io/library/httpd:2.4-alpine",
  "docker.io/library/redis:7",
  "docker.io/library/busybox:1.37",
  "docker.io/library/golang:1.22",
  ELASTICSEARCH_DEFAULT_IMAGE,
  "docker.io/getmeili/meilisearch:v1.11",
  "docker.io/axllent/mailpit:v1.30.1",
  "docker.io/library/mariadb:10.11",
  "docker.io/library/mariadb:11.4",
  "docker.io/library/mariadb:11.8",
  "docker.io/library/memcached:1.6",
  "docker.io/library/mongo:7",
  "docker.io/library/mysql:8.0",
  `docker.io/library/${NGINX_DEFAULT_IMAGE}`,
  "docker.io/opensearchproject/opensearch:2",
  "docker.io/library/solr:9",
  "docker.io/library/traefik:v3.3",
  "docker.io/valkey/valkey:8",
];

const nightlyDatabaseImages = [
  "docker.io/library/mysql:8.4",
  "docker.io/library/postgres:17",
  "docker.io/library/mongo:8.0",
  "docker.io/library/mongo:8.3",
] as const;

const dockerHubMirrorConfig = `          # Only CI Podman pulls read this copy; the managed daemon keeps its own registry config.
          {
            cat "$LANDO_USER_DATA_ROOT/runtime/config/registries.conf"
            cat <<'EOF'

          [[registry]]
          location = "docker.io"

          [[registry.mirror]]
          location = "mirror.gcr.io"
          EOF
          } > "$RUNNER_TEMP/ci-registries.conf"
`;

const parallelPulls = `          pull_images() {
            local images=("$@") pids=()
            local workers=4 worker pid status=0
            for ((worker=0; worker<workers && worker<\${#images[@]}; worker++)); do
              (
                local index failed=0
                for ((index=worker; index<\${#images[@]}; index+=workers)); do
                  pull_image "\${images[index]}" || failed=1
                done
                exit "$failed"
              ) &
              pids+=("$!")
            done
            for pid in "\${pids[@]}"; do
              wait "$pid" || status=1
            done
            return "$status"
          }
          podman_images=()
          if test "\${{ matrix.suite }}" = services; then
            podman_images+=(
${identityImages.map((image) => `              ${image}`).join("\n")}
            )
          fi
          podman_images+=(
            # Every supported Node major is pre-pulled from the service-type table.
${commonImages.map((image) => `            ${image}`).join("\n")}
          )
          pull_images "\${podman_images[@]}" || exit 1`;

export const podmanPullFunctionCommands = (mirrorDockerHub: boolean): string => {
  const mirrorEnv = mirrorDockerHub
    ? `              CONTAINERS_REGISTRIES_CONF="$RUNNER_TEMP/ci-registries.conf" \\
`
    : "";
  return `${mirrorDockerHub ? dockerHubMirrorConfig : ""}          pull_image() {
            local image="$1"
            for attempt in 1 2 3; do
${mirrorEnv}              "$LANDO_PODMAN" "\${LANDO_PODMAN_ARGS[@]}" pull "$image" && return 0
              if test "$attempt" -eq 3; then return 1; fi
              sleep $((attempt * 5))
            done
          }`;
};

export const podmanImagePullCommands = (mode: "provider-matrix" | "standard" | "nightly-guides"): string => {
  if (mode === "provider-matrix") return parallelPulls;
  const base = commonImages
    .flatMap((image, index) =>
      index === 1
        ? [
            "          # Every supported Node major is pre-pulled from the service-type table.",
            `          pull_image ${image}`,
          ]
        : [`          pull_image ${image}`],
    )
    .join("\n");
  return mode === "standard"
    ? base
    : `${base}
          # Version-change guides that do not run in the PR smoke lane.
${nightlyDatabaseImages.map((image) => `          pull_image ${image}`).join("\n")}`;
};
