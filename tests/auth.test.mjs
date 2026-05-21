import test from "node:test";
import assert from "node:assert/strict";
import {
  authStatusHandler,
  githubAuthCallbackHandler,
  githubAuthStartHandler
} from "../apps/control-plane/auth.mjs";

test("starts GitHub OAuth with org-read scope and state cookie", async () => {
  await withEnv({
    RUNNERLY_GITHUB_OAUTH_CLIENT_ID: "client-id",
    RUNNERLY_GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
    RUNNERLY_PUBLIC_BASE_URL: "https://runnerly.example.test"
  }, async () => {
    const response = createResponse();

    await githubAuthStartHandler(createRequest(), response, { sendJson });

    assert.equal(response.statusCode, 302);
    assert.match(response.headers.location, /^https:\/\/github\.com\/login\/oauth\/authorize/);

    const location = new URL(response.headers.location);
    assert.equal(location.searchParams.get("client_id"), "client-id");
    assert.equal(location.searchParams.get("redirect_uri"), "https://runnerly.example.test/api/auth/github/callback");
    assert.equal(location.searchParams.get("scope"), "read:org");
    assert.ok(location.searchParams.get("state"));
    assert.equal(cookieValue(response.headers, "runnerly_oauth_state"), location.searchParams.get("state"));
  });
});

test("accepts GitHub org admins as dashboard admins", async () => {
  await withEnv({
    RUNNERLY_GITHUB_OAUTH_CLIENT_ID: "client-id",
    RUNNERLY_GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
    RUNNERLY_GITHUB_ADMIN_ORG: "example-org",
    RUNNERLY_PUBLIC_BASE_URL: "https://runnerly.example.test",
    RUNNERLY_SESSION_SECRET: "session-secret"
  }, async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/login/oauth/access_token") {
        return jsonResponse({ access_token: "github-token" });
      }

      if (parsed.pathname === "/user") {
        return textResponse({ login: "example-org-admin", id: 123 });
      }

      if (parsed.pathname === "/user/memberships/orgs/example-org") {
        return textResponse({ state: "active", role: "admin" });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };

    try {
      const response = createResponse();
      const state = "oauth-state";
      await githubAuthCallbackHandler(
        createRequest({ cookie: `runnerly_oauth_state=${state}` }),
        response,
        new URL(`/api/auth/github/callback?code=good&state=${state}`, "https://runnerly.example.test")
      );

      assert.equal(response.statusCode, 302);
      assert.equal(response.headers.location, "/");
      assert.ok(cookieValue(response.headers, "runnerly_session"));

      const statusResponse = createResponse();
      await authStatusHandler(
        createRequest({ cookie: `runnerly_session=${cookieValue(response.headers, "runnerly_session")}` }),
        statusResponse,
        { sendJson }
      );

      assert.equal(statusResponse.payload.authRequired, true);
      assert.equal(statusResponse.payload.authenticated, true);
      assert.equal(statusResponse.payload.user.login, "example-org-admin");
      assert.equal(statusResponse.payload.user.role, "admin");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("rejects GitHub users outside the configured admin team", async () => {
  await withEnv({
    RUNNERLY_GITHUB_OAUTH_CLIENT_ID: "client-id",
    RUNNERLY_GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
    RUNNERLY_GITHUB_ADMIN_ORG: "example-org",
    RUNNERLY_GITHUB_ADMIN_TEAM_SLUGS: "admins",
    RUNNERLY_GITHUB_ALLOW_ORG_ADMINS: "false",
    RUNNERLY_PUBLIC_BASE_URL: "https://runnerly.example.test",
    RUNNERLY_SESSION_SECRET: "session-secret"
  }, async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/login/oauth/access_token") {
        return jsonResponse({ access_token: "github-token" });
      }

      if (parsed.pathname === "/user") {
        return textResponse({ login: "org-member", id: 456 });
      }

      if (parsed.pathname === "/user/memberships/orgs/example-org") {
        return textResponse({ state: "active", role: "member" });
      }

      if (parsed.pathname === "/orgs/example-org/teams/admins/memberships/org-member") {
        return textResponse({ message: "Not Found" }, 404);
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };

    try {
      const response = createResponse();
      const state = "oauth-state";
      await githubAuthCallbackHandler(
        createRequest({ cookie: `runnerly_oauth_state=${state}` }),
        response,
        new URL(`/api/auth/github/callback?code=good&state=${state}`, "https://runnerly.example.test")
      );

      assert.equal(response.statusCode, 302);
      assert.equal(response.headers.location, "/login.html?error=github_not_authorized");
      assert.equal(cookieValue(response.headers, "runnerly_session"), null);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("requires configured admin team membership even for org admins by default", async () => {
  await withEnv({
    RUNNERLY_GITHUB_OAUTH_CLIENT_ID: "client-id",
    RUNNERLY_GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
    RUNNERLY_GITHUB_ADMIN_ORG: "example-org",
    RUNNERLY_GITHUB_ADMIN_TEAM_SLUGS: "platform-admins",
    RUNNERLY_PUBLIC_BASE_URL: "https://runnerly.example.test",
    RUNNERLY_SESSION_SECRET: "session-secret"
  }, async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/login/oauth/access_token") {
        return jsonResponse({ access_token: "github-token" });
      }

      if (parsed.pathname === "/user") {
        return textResponse({ login: "org-owner", id: 789 });
      }

      if (parsed.pathname === "/user/memberships/orgs/example-org") {
        return textResponse({ state: "active", role: "admin" });
      }

      if (parsed.pathname === "/orgs/example-org/teams/platform-admins/memberships/org-owner") {
        return textResponse({ message: "Not Found" }, 404);
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };

    try {
      const response = createResponse();
      const state = "oauth-state";
      await githubAuthCallbackHandler(
        createRequest({ cookie: `runnerly_oauth_state=${state}` }),
        response,
        new URL(`/api/auth/github/callback?code=good&state=${state}`, "https://runnerly.example.test")
      );

      assert.equal(response.statusCode, 302);
      assert.equal(response.headers.location, "/login.html?error=github_not_authorized");
      assert.equal(cookieValue(response.headers, "runnerly_session"), null);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

async function withEnv(values, fn) {
  const previous = {};
  const keys = new Set([
    ...Object.keys(values),
    "RUNNERLY_ADMIN_TOKEN",
    "RUNNERLY_TOKEN_LOGIN_ENABLED",
    "RUNNERLY_GITHUB_ALLOW_ORG_ADMINS",
    "RUNNERLY_GITHUB_ADMIN_TEAM_SLUG",
    "RUNNERLY_GITHUB_ADMIN_TEAM_SLUGS"
  ]);

  for (const key of keys) {
    previous[key] = process.env[key];
    delete process.env[key];
  }

  Object.assign(process.env, values);

  try {
    await fn();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}

function createRequest(headers = {}) {
  return {
    headers: {
      host: "runnerly.example.test",
      ...headers
    }
  };
}

function createResponse() {
  return {
    statusCode: null,
    headers: {},
    payload: null,
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    }
  };
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.payload = payload;
  response.end(JSON.stringify(payload));
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  };
}

function textResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload)
  };
}

function cookieValue(headers, name) {
  const cookies = Array.isArray(headers["set-cookie"]) ? headers["set-cookie"] : [headers["set-cookie"]];
  const cookie = cookies.filter(Boolean).find((value) => value.startsWith(`${name}=`));
  if (!cookie) {
    return null;
  }

  return decodeURIComponent(cookie.split(";", 1)[0].slice(name.length + 1));
}
