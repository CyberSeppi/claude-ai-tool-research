import { test } from "node:test";
import assert from "node:assert/strict";
import { createOAuthClient } from "./oauth.mjs";

const baseCfg = {
  tokenUrl: "https://auth/example/token",
  clientId: "cid",
  clientSecret: "csec",
  scope: "machine2machine",
};

function fakeFetch(replies) {
  let i = 0;
  return async (url, init) => {
    const reply = replies[i++] ?? replies[replies.length - 1];
    if (typeof reply === "function") return reply(url, init);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
}

test("first call fetches a token and returns it", async () => {
  const fetchImpl = fakeFetch([{ body: { access_token: "T1", expires_in: 3600 } }]);
  const oauth = createOAuthClient({ ...baseCfg, fetchImpl, now: () => 0 });
  assert.equal(await oauth.getAccessToken(), "T1");
});

test("second call within TTL reuses the cached token", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response(JSON.stringify({ access_token: "T1", expires_in: 3600 }), { status: 200 });
  };
  const oauth = createOAuthClient({ ...baseCfg, fetchImpl, now: () => 0 });
  await oauth.getAccessToken();
  await oauth.getAccessToken();
  assert.equal(calls, 1);
});

test("expired token triggers a refresh (30 s buffer)", async () => {
  const replies = [
    { body: { access_token: "T1", expires_in: 60 } },
    { body: { access_token: "T2", expires_in: 60 } },
  ];
  const fetchImpl = fakeFetch(replies);
  let t = 0;
  const oauth = createOAuthClient({ ...baseCfg, fetchImpl, now: () => t * 1000 });
  assert.equal(await oauth.getAccessToken(), "T1");
  t = 31; // inside the 30s expiry buffer
  assert.equal(await oauth.getAccessToken(), "T2");
});

test("concurrent callers during refresh share one in-flight request", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 20));
    return new Response(JSON.stringify({ access_token: "T1", expires_in: 3600 }), { status: 200 });
  };
  const oauth = createOAuthClient({ ...baseCfg, fetchImpl, now: () => 0 });
  await Promise.all([oauth.getAccessToken(), oauth.getAccessToken(), oauth.getAccessToken()]);
  assert.equal(calls, 1);
});

test("non-2xx response surfaces an error", async () => {
  const fetchImpl = async () => new Response("nope", { status: 500 });
  const oauth = createOAuthClient({ ...baseCfg, fetchImpl, now: () => 0 });
  await assert.rejects(() => oauth.getAccessToken(), /OAuth.*500/);
});
