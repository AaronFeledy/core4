import type { AppFeatureDefinition } from "@lando/sdk/services";

import { nginxPhpFpmWireFeature } from "../services/nginx.ts";
import { phpDbClientFeature } from "../services/php-db-client.ts";
import { phpMyAdminWireFeature } from "../services/phpmyadmin.ts";

export const appFeatures: ReadonlyMap<string, AppFeatureDefinition> = new Map([
  [phpDbClientFeature.id, phpDbClientFeature],
  [phpMyAdminWireFeature.id, phpMyAdminWireFeature],
  [nginxPhpFpmWireFeature.id, nginxPhpFpmWireFeature],
]);
