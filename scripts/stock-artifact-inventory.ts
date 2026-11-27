import { canonicalImageReference } from "@lando/sdk/schema";
import { serviceTypes } from "../plugins/service-lando/src/index.ts";
import { MAILPIT_IMAGE } from "../plugins/service-lando/src/mailpit-constants.ts";
import { DEFAULT_IMAGE as APACHE_IMAGE } from "../plugins/service-lando/src/services/apache.ts";
import { DEFAULT_IMAGE as LOCALSTACK_IMAGE } from "../plugins/service-lando/src/services/localstack.ts";
import { MAILHOG_IMAGE } from "../plugins/service-lando/src/services/mailhog.ts";
import { DEFAULT_IMAGE as MEMCACHED_IMAGE } from "../plugins/service-lando/src/services/memcached.ts";
import {
  PHP_VIA_MODES,
  SUPPORTED_PHP_VERSIONS,
  phpImageFor,
} from "../plugins/service-lando/src/services/php-via.ts";
import { STATIC_SERVER_IMAGES } from "../plugins/service-lando/src/services/static.ts";
import { DEFAULT_IMAGE as VALKEY_IMAGE } from "../plugins/service-lando/src/services/valkey.ts";

export const stockArtifactReferences = (): readonly string[] => {
  const catalog = [...serviceTypes.values()].flatMap(({ artifacts }) => Object.values(artifacts ?? {}));
  if (catalog.length === 0) throw new Error("Bundled service artifact catalog is empty");

  const defaults = [
    APACHE_IMAGE,
    LOCALSTACK_IMAGE,
    MAILHOG_IMAGE,
    MAILPIT_IMAGE,
    MEMCACHED_IMAGE,
    VALKEY_IMAGE,
    // The standalone nginx service and static:nginx currently share this stock image.
    ...Object.values(STATIC_SERVER_IMAGES),
    ...SUPPORTED_PHP_VERSIONS.flatMap((version) => PHP_VIA_MODES.map((via) => phpImageFor(version, via))),
  ];

  // De-duplicate aliases, but report the service owner's spelling (including digest pins).
  return [
    ...new Map([...catalog, ...defaults].map((ref) => [canonicalImageReference(ref), ref])).values(),
  ].sort();
};
