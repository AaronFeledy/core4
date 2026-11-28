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
            # The managed daemon owns its registries.conf. Mirror only these CI CLI pulls
            # into the daemon's image store, so live tests still use the original image names.
            export CONTAINERS_REGISTRIES_CONF="$LANDO_USER_DATA_ROOT/runtime/config/registries.conf"
            export CONTAINERS_REGISTRIES_CONF_OVERRIDE="$RUNNER_TEMP/ci-docker-hub.conf"
            cat > "$CONTAINERS_REGISTRIES_CONF_OVERRIDE" <<'EOF'
          [[registry]]
          location = "docker.io"

          [[registry.mirror]]
          location = "mirror.gcr.io"
          EOF
${identityImages.map((image) => `            pull_image docker.io/library/${image}`).join("\n")}
          fi`;
