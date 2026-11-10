// Captured serialization of routing.ts before 6163f33fe, with TLS paths from tls.ts.
export const legacyContent = `http:
  routers:
    route-old%2Fapp-0-http:
      rule: "Host(\\"old.lndo.site\\") && PathPrefix(\\"/api\\")"
      entryPoints: [web]
      priority: 65540
      service: route-old%2Fapp-0
      middlewares:
        - "route-old%2Fapp-0-f0-stripPrefix"
        - "route-old%2Fapp-0-f1-addPrefix"
        - "route-old%2Fapp-0-f2-requestHeader"
        - "route-old%2Fapp-0-f3-responseHeader"
        - "route-old%2Fapp-0-f4-redirect"
    route-old%2Fapp-0-https:
      rule: "Host(\\"old.lndo.site\\") && PathPrefix(\\"/api\\")"
      entryPoints: [websecure]
      priority: 65540
      service: route-old%2Fapp-0
      tls: {}
      middlewares:
        - "route-old%2Fapp-0-f0-stripPrefix"
        - "route-old%2Fapp-0-f1-addPrefix"
        - "route-old%2Fapp-0-f2-requestHeader"
        - "route-old%2Fapp-0-f3-responseHeader"
        - "route-old%2Fapp-0-f4-redirect"
  services:
    route-old%2Fapp-0:
      loadBalancer:
        servers:
          - url: http://web.old-app.internal:8080
  middlewares:
    "route-old%2Fapp-0-f0-stripPrefix": {"stripPrefix":{"prefixes":["/api"]}}
    "route-old%2Fapp-0-f1-addPrefix": {"addPrefix":{"prefix":"/v1"}}
    "route-old%2Fapp-0-f2-requestHeader": {"headers":{"customRequestHeaders":{"X-App":"old"}}}
    "route-old%2Fapp-0-f3-responseHeader": {"headers":{"customResponseHeaders":{"X-App":"old"}}}
    "route-old%2Fapp-0-f4-redirect": {"redirectRegex":{"regex":"^.*$","replacement":"https://new.lndo.site","permanent":false}}
tls:
  certificates:
    - certFile: /etc/traefik/dynamic/certs/old%2Fapp.crt
      keyFile: /etc/traefik/dynamic/certs/old%2Fapp.key
`;
export const legacyName = "routes-old%2Fapp.yml";
export const legacyHttpContent = `http:
  routers:
    route-plain-0-http:
      rule: "Host(\\"plain.lndo.site\\")"
      entryPoints: [web]
      priority: 65539
      service: route-plain-0
  services:
    route-plain-0:
      loadBalancer:
        servers:
          - url: http://web.plain.internal:80
`;
