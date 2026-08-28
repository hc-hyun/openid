export const config = Object.freeze({
  issuer: (process.env.SKILLS_OIDC_ISSUER ?? "http://localhost:8080/realms/oidc-test").replace(
    /\/$/,
    "",
  ),
  clientId: process.env.SKILLS_OIDC_CLIENT_ID ?? "skills-cli",
  audience: process.env.SKILLS_OIDC_AUDIENCE ?? "skills-api",
  mcpAudience: process.env.SKILLS_MCP_AUDIENCE ?? "http://localhost:3200/mcp",
  scope:
    process.env.SKILLS_OIDC_SCOPE ??
    "openid profile email offline_access skills.read mcp.tools",
  apiUrl: (process.env.SKILLS_API_URL ?? "http://localhost:3200").replace(/\/$/, ""),
});
