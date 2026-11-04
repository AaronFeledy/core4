export function createSiteUrlPolicy(site, previewOrigin) {
  const origins = new Set();
  if (site) {
    const configured = new URL(site);
    if (!["http:", "https:"].includes(configured.protocol)) {
      throw new Error("Docs site must use HTTP or HTTPS.");
    }
    // Default sites use the standard HTTP/HTTPS ports. Explicit non-default sites keep their port.
    const ports = configured.port ? [configured.port] : ["80", "443"];
    for (const protocol of ["http:", "https:"]) {
      for (const port of ports) {
        const alias = new URL(configured);
        alias.protocol = protocol;
        alias.port = port;
        origins.add(alias.origin);
      }
    }
  }
  const urlRewriteExpressions = [...origins].map((origin) => {
    const [scheme, authority] = origin.split("://");
    const escapedAuthority = authority.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return {
      pattern: new RegExp(`^${scheme}://(?:[^/?#]*@)?${escapedAuthority}(?=[/?#]|$)`),
      replacement: previewOrigin,
    };
  });
  return {
    urlRewriteExpressions,
    linksToSkip: async (link) => {
      const { origin } = new URL(link);
      return origin !== previewOrigin && !origins.has(origin);
    },
    toLocalUrl: (url) => {
      if (origins.has(url.origin)) {
        return new URL(`${previewOrigin}${url.pathname}${url.search}${url.hash}`);
      }
      return url.origin === previewOrigin ? url : undefined;
    },
  };
}
