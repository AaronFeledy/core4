// mongosh's eval rewriter cannot evaluate optional method calls such as clientSource?.join().
export const mongoAdminProof = `
const info = admin.runCommand({usersInfo:{user:"lando_admin",db:"admin"},showAuthenticationRestrictions:true});
const user = info.users?.[0];
const rules = user?.authenticationRestrictions;
const rule = rules?.[0];
const loopbackOnly = (addresses) => Array.isArray(addresses) && addresses.length === 1 && addresses[0] === "127.0.0.1";
const adminVerified = info.ok === 1 && info.users.length === 1 && user.customData?.lando === "db-admin:v1" &&
  user.roles.some(r => r.role === "root" && r.db === "admin") && rules?.length === 1 &&
  loopbackOnly(rule.clientSource) && loopbackOnly(rule.serverAddress);
`;
