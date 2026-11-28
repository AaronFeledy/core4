import {
  PHP_VIA_MODES,
  SUPPORTED_PHP_VERSIONS,
  phpImageFor,
} from "../plugins/service-lando/src/services/php-via.ts";
import { varnishServiceType } from "../plugins/service-lando/src/services/varnish.ts";

const identityImages = [
  ...SUPPORTED_PHP_VERSIONS.flatMap((version) => PHP_VIA_MODES.map((via) => phpImageFor(version, via))),
  ...Object.values(varnishServiceType.artifacts ?? {}),
];

export const servicesImagePullCommands = `
          if test "\${{ matrix.suite }}" = services; then
${identityImages.map((image) => `            pull_image docker.io/library/${image}`).join("\n")}
          fi`;

const dockerHubMirrorConfig = `          # The managed daemon owns its registry config. Only CI Podman pulls load this override.
          cat > "$RUNNER_TEMP/ci-docker-hub.conf" <<'EOF'
          [[registry]]
          location = "docker.io"

          [[registry.mirror]]
          location = "mirror.gcr.io"
          EOF
`;

export const podmanImagePullCommands = (mirrorDockerHub: boolean): string => {
  const mirrorEnv = mirrorDockerHub
    ? `              CONTAINERS_REGISTRIES_CONF="$LANDO_USER_DATA_ROOT/runtime/config/registries.conf" \\
              CONTAINERS_REGISTRIES_CONF_OVERRIDE="$RUNNER_TEMP/ci-docker-hub.conf" \\
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
