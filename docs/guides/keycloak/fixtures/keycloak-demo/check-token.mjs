const discoveryUrl = "http://keycloak:8080/realms/demo/.well-known/openid-configuration";
const discovery = await (await fetch(discoveryUrl)).json();

const response = await fetch(discovery.token_endpoint, {
  method: "POST",
  body: new URLSearchParams({
    grant_type: "password",
    client_id: "demo-app",
    client_secret: "local-development-only",
    username: "alice",
    password: "alice",
  }),
});
if (!response.ok) {
  console.error(`token request failed: ${response.status} ${await response.text()}`);
  process.exit(1);
}

const { access_token } = await response.json();
const claims = JSON.parse(Buffer.from(access_token.split(".")[1], "base64url").toString());
console.log(`browser login: ${discovery.authorization_endpoint}`);
console.log(`token endpoint: ${discovery.token_endpoint}`);
console.log(`signing keys: ${discovery.jwks_uri}`);
console.log(`user: ${claims.preferred_username}`);
console.log(`issuer: ${claims.iss}`);
if (claims.iss !== process.env.OIDC_ISSUER) {
  console.error(`issuer does not match OIDC_ISSUER (${process.env.OIDC_ISSUER})`);
  process.exit(1);
}
console.log("issuer matches OIDC_ISSUER");
