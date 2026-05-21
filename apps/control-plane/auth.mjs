import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const sessionCookieName = "runnerly_session";
const oauthStateCookieName = "runnerly_oauth_state";
const sessionMaxAgeSeconds = 12 * 60 * 60;
const oauthStateMaxAgeSeconds = 10 * 60;
const githubApiBaseUrl = process.env.RUNNERLY_GITHUB_API_BASE_URL ?? "https://api.github.com";
const githubWebUrl = process.env.RUNNERLY_GITHUB_WEB_URL ?? "https://github.com";

export function isAdminAuthEnabled() {
  return isTokenLoginEnabled() || isGitHubAuthEnabled();
}

export function requireAdmin(request) {
  if (!isAdminAuthEnabled()) {
    return;
  }

  const bearer = readBearerToken(request);
  const cookieToken = readCookie(request, sessionCookieName);

  if (isTokenLoginEnabled() && safeEqual(bearer, process.env.RUNNERLY_ADMIN_TOKEN)) {
    return;
  }

  if (isTokenLoginEnabled() && safeEqual(cookieToken, sessionDigest(process.env.RUNNERLY_ADMIN_TOKEN))) {
    return;
  }

  if (verifySessionCookie(cookieToken)) {
    return;
  }

  const error = new Error("unauthorized");
  error.statusCode = 401;
  throw error;
}

export async function loginHandler(request, response, { readJson, sendJson }) {
  const expected = process.env.RUNNERLY_ADMIN_TOKEN;
  if (!isAdminAuthEnabled()) {
    sendJson(response, 200, { authenticated: true, authRequired: false });
    return;
  }

  if (!isTokenLoginEnabled()) {
    sendJson(response, 403, { error: "token_login_disabled" });
    return;
  }

  const payload = await readJson(request);
  if (!safeEqual(payload.token, expected)) {
    sendJson(response, 401, { error: "invalid_token" });
    return;
  }

  response.writeHead(204, {
    "set-cookie": buildCookie(sessionCookieName, sessionDigest(expected), {
      maxAge: sessionMaxAgeSeconds,
      secure: shouldUseSecureCookie(request)
    }),
    "cache-control": "no-store"
  });
  response.end();
}

export async function logoutHandler(_request, response) {
  response.writeHead(204, {
    "set-cookie": [
      expireCookie(sessionCookieName),
      expireCookie(oauthStateCookieName)
    ],
    "cache-control": "no-store"
  });
  response.end();
}

export async function authStatusHandler(request, response, { sendJson }) {
  const session = authenticatedSession(request);

  sendJson(response, 200, {
    authRequired: isAdminAuthEnabled(),
    authenticated: Boolean(session),
    user: session?.user ?? null,
    providers: {
      token: isTokenLoginEnabled(),
      github: isGitHubAuthEnabled()
    }
  });
}

export async function githubAuthStartHandler(request, response, { sendJson }) {
  if (!isGitHubAuthEnabled()) {
    sendJson(response, 503, { error: "github_auth_not_configured" });
    return;
  }

  const state = makeToken();
  const redirectUri = githubCallbackUrl(request);
  const authorizationUrl = new URL("/login/oauth/authorize", githubWebUrl);
  authorizationUrl.searchParams.set("client_id", process.env.RUNNERLY_GITHUB_OAUTH_CLIENT_ID);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("scope", "read:org");
  authorizationUrl.searchParams.set("state", state);

  response.writeHead(302, {
    location: authorizationUrl.toString(),
    "set-cookie": buildCookie(oauthStateCookieName, state, {
      maxAge: oauthStateMaxAgeSeconds,
      sameSite: "Lax",
      secure: shouldUseSecureCookie(request)
    }),
    "cache-control": "no-store"
  });
  response.end();
}

export async function githubAuthCallbackHandler(request, response, url) {
  if (!isGitHubAuthEnabled()) {
    redirectToLogin(response, "github_not_configured");
    return;
  }

  if (url.searchParams.get("error")) {
    redirectToLogin(response, "github_denied");
    return;
  }

  const state = url.searchParams.get("state");
  const expectedState = readCookie(request, oauthStateCookieName);
  if (!state || !safeEqual(state, expectedState)) {
    redirectToLogin(response, "github_state");
    return;
  }

  const code = url.searchParams.get("code");
  if (!code) {
    redirectToLogin(response, "github_code");
    return;
  }

  try {
    const token = await exchangeOAuthCode(code, githubCallbackUrl(request));
    const user = await githubApiRequest("/user", token.access_token);
    const authorization = await authorizeGitHubAdmin(user, token.access_token);

    if (!authorization.authorized) {
      redirectToLogin(response, "github_not_authorized");
      return;
    }

    const sessionValue = signSession({
      provider: "github",
      login: user.login,
      id: user.id,
      org: authorization.org,
      role: authorization.role,
      team: authorization.team,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + sessionMaxAgeSeconds
    });

    response.writeHead(302, {
      location: "/",
      "set-cookie": [
        buildCookie(sessionCookieName, sessionValue, {
          maxAge: sessionMaxAgeSeconds,
          secure: shouldUseSecureCookie(request)
        }),
        expireCookie(oauthStateCookieName)
      ],
      "cache-control": "no-store"
    });
    response.end();
  } catch (error) {
    console.error(error);
    redirectToLogin(response, "github_auth_failed");
  }
}

export function redirectToLogin(response, reason) {
  const location = reason ? `/login.html?error=${encodeURIComponent(reason)}` : "/login.html";
  response.writeHead(302, {
    location,
    "cache-control": "no-store"
  });
  response.end();
}

function authenticatedSession(request) {
  if (!isAdminAuthEnabled()) {
    return { provider: "none", user: null };
  }

  try {
    requireAdmin(request);
  } catch {
    return null;
  }

  const githubSession = verifySessionCookie(readCookie(request, sessionCookieName));
  if (githubSession) {
    return githubSession;
  }

  return { provider: "token", user: null };
}

function isTokenLoginEnabled() {
  return Boolean(process.env.RUNNERLY_ADMIN_TOKEN) && process.env.RUNNERLY_TOKEN_LOGIN_ENABLED !== "false";
}

function isGitHubAuthEnabled() {
  return Boolean(
    process.env.RUNNERLY_GITHUB_OAUTH_CLIENT_ID &&
      process.env.RUNNERLY_GITHUB_OAUTH_CLIENT_SECRET
  );
}

async function exchangeOAuthCode(code, redirectUri) {
  const response = await fetch(new URL("/login/oauth/access_token", githubWebUrl), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "runnerly-control-plane"
    },
    body: new URLSearchParams({
      client_id: process.env.RUNNERLY_GITHUB_OAUTH_CLIENT_ID,
      client_secret: process.env.RUNNERLY_GITHUB_OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri
    }).toString()
  });

  const payload = await response.json();
  if (!response.ok || !payload.access_token) {
    throw Object.assign(new Error(payload.error_description ?? payload.error ?? "GitHub OAuth token exchange failed"), {
      statusCode: response.status
    });
  }

  return payload;
}

async function authorizeGitHubAdmin(user, token) {
  const login = user?.login;
  const org = process.env.RUNNERLY_GITHUB_ADMIN_ORG ?? "example-org";
  if (!login) {
    return { authorized: false, org };
  }

  const membership = await githubApiRequest(`/user/memberships/orgs/${encodeURIComponent(org)}`, token, {
    allowNotFound: true
  });

  if (membership?.state !== "active") {
    return { authorized: false, org };
  }

  const adminTeams = githubAdminTeamSlugs();
  const allowOrgAdmins = process.env.RUNNERLY_GITHUB_ALLOW_ORG_ADMINS === "true" ||
    (!adminTeams.length && process.env.RUNNERLY_GITHUB_ALLOW_ORG_ADMINS !== "false");

  if (allowOrgAdmins && membership.role === "admin") {
    return { authorized: true, org, role: "admin", team: null };
  }

  for (const team of adminTeams) {
    const teamMembership = await githubApiRequest(
      `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(team)}/memberships/${encodeURIComponent(login)}`,
      token,
      { allowNotFound: true }
    );

    if (teamMembership?.state === "active") {
      return { authorized: true, org, role: membership.role, team };
    }
  }

  return { authorized: false, org, role: membership.role };
}

function githubAdminTeamSlugs() {
  const raw = process.env.RUNNERLY_GITHUB_ADMIN_TEAM_SLUGS ?? process.env.RUNNERLY_GITHUB_ADMIN_TEAM_SLUG ?? "";
  return raw
    .split(",")
    .map((team) => team.trim())
    .filter(Boolean);
}

async function githubApiRequest(pathname, token, { allowNotFound = false } = {}) {
  const response = await fetch(new URL(pathname, githubApiBaseUrl), {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "runnerly-control-plane"
    }
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (allowNotFound && response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw Object.assign(new Error(payload.message ?? `GitHub API returned ${response.status}`), {
      statusCode: response.status
    });
  }

  return payload;
}

function githubCallbackUrl(request) {
  if (process.env.RUNNERLY_GITHUB_OAUTH_CALLBACK_URL) {
    return process.env.RUNNERLY_GITHUB_OAUTH_CALLBACK_URL;
  }

  return `${requestOrigin(request)}/api/auth/github/callback`;
}

function requestOrigin(request) {
  if (process.env.RUNNERLY_PUBLIC_BASE_URL) {
    return process.env.RUNNERLY_PUBLIC_BASE_URL.replace(/\/+$/, "");
  }

  const forwardedProto = headerValue(request.headers["x-forwarded-proto"]);
  const forwardedHost = headerValue(request.headers["x-forwarded-host"]);
  const proto = forwardedProto ?? "http";
  const host = forwardedHost ?? request.headers.host ?? "127.0.0.1:8787";
  return `${proto}://${host}`;
}

function signSession(payload) {
  const secret = sessionSecret();
  if (!secret) {
    throw Object.assign(new Error("RUNNERLY_SESSION_SECRET is required for GitHub login"), { statusCode: 503 });
  }

  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `v1.${body}.${signature}`;
}

function verifySessionCookie(value) {
  const secret = sessionSecret();
  if (!value || !secret || !value.startsWith("v1.")) {
    return null;
  }

  const [, body, signature] = value.split(".");
  if (!body || !signature) {
    return null;
  }

  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  if (!safeEqual(signature, expected)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (payload.provider !== "github" || !payload.login || payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return {
      provider: "github",
      user: {
        login: payload.login,
        id: payload.id,
        org: payload.org,
        role: payload.role ?? null,
        team: payload.team ?? null
      }
    };
  } catch {
    return null;
  }
}

function sessionSecret() {
  return process.env.RUNNERLY_SESSION_SECRET ?? process.env.RUNNERLY_ADMIN_TOKEN ?? process.env.RUNNERLY_AGENT_TOKEN;
}

function buildCookie(name, value, { maxAge, sameSite = "Lax", secure = false } = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "HttpOnly",
    `SameSite=${sameSite}`,
    "Path=/"
  ];

  if (Number.isInteger(maxAge)) {
    parts.push(`Max-Age=${maxAge}`);
  }

  if (secure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function expireCookie(name) {
  return `${name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function shouldUseSecureCookie(request) {
  if (process.env.RUNNERLY_COOKIE_SECURE) {
    return process.env.RUNNERLY_COOKIE_SECURE !== "false";
  }

  if (process.env.RUNNERLY_PUBLIC_BASE_URL?.startsWith("https://")) {
    return true;
  }

  return headerValue(request.headers["x-forwarded-proto"]) === "https";
}

function sessionDigest(token) {
  return createHash("sha256").update(`runnerly:${token}`).digest("hex");
}

function readBearerToken(request) {
  const header = request.headers.authorization ?? "";
  const [scheme, token] = header.split(/\s+/, 2);
  return scheme?.toLowerCase() === "bearer" ? token : null;
}

function readCookie(request, name) {
  const cookieHeader = request.headers.cookie ?? "";
  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) {
      return decodeURIComponent(rawValue.join("="));
    }
  }
  return null;
}

function headerValue(value) {
  return Array.isArray(value) ? value.at(0) : value;
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }

  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
}

export function makeToken() {
  return randomBytes(32).toString("base64url");
}
