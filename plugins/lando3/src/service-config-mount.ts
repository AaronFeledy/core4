import type { CatalogEntry } from "./catalog.ts";

export const serviceConfigMount = (
  catalog: { readonly id: string; readonly entry: CatalogEntry | undefined },
  key: string,
  service: Readonly<Record<string, unknown>>,
): { readonly target: string; readonly companion: boolean } | undefined => {
  if (catalog.id === "php") {
    const via = service.via;
    const nginx = via === "nginx" || (typeof via === "string" && via.startsWith("nginx:"));
    if (key === "php")
      return { target: "/usr/local/etc/php/conf.d/zzz-lando-my-custom.ini", companion: false };
    if (key === "pool") return { target: "/usr/local/etc/php-fpm.d/zz-lando.conf", companion: false };
    if (key === "vhosts") {
      return {
        target: nginx ? "/etc/nginx/conf.d/default.conf" : "/etc/apache2/sites-enabled/000-default.conf",
        companion: nginx,
      };
    }
    if (key === "server") {
      return { target: nginx ? "/etc/nginx/nginx.conf" : "/etc/apache2/apache2.conf", companion: nginx };
    }
    return undefined;
  }
  const target = catalog.entry?.configMounts?.[key];
  return target === undefined ? undefined : { target, companion: false };
};
