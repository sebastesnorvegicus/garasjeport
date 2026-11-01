import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

function fakeKV() {
  const store = new Map();
  return {
    store,
    async get(key, type) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

let env;
let downlinkCalls;
const realFetch = globalThis.fetch;

beforeEach(() => {
  env = {
    GARAGE: fakeKV(),
    ALLOWED_ORIGIN: "https://dag.github.io",
    TTN_BASE_URL: "https://eu1.cloud.thethings.network",
    TTN_APP_ID: "garasjeport-hellargata",
    TTN_DEVICE_ID: "garasjeport-node",
    TTN_WEBHOOK_ID: "cf-worker",
    CLOSED_SENSOR: "DI1",
    PULSE_PAYLOAD: "BQEQA+g=",
    TTN_API_KEY: "NNSXS.test",
    WEBHOOK_SECRET: "hook-secret",
    APP_TOKEN: "app-token",
  };
  downlinkCalls = [];
  globalThis.fetch = async (url, init) => {
    downlinkCalls.push({ url, init });
    return new Response("{}", { status: 200 });
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const W = "https://garasjeport.example.workers.dev";

function uplinkRequest(payload, { secret = "hook-secret", confirmed = false, receivedAt = new Date().toISOString() } = {}) {
  return new Request(`${W}/ttn/uplink`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Webhook-Secret": secret },
    body: JSON.stringify({
      end_device_ids: { device_id: "garasjeport-node" },
      uplink_message: {
        f_port: 2,
        f_cnt: 1,
        confirmed,
        received_at: receivedAt,
        decoded_payload: payload,
        rx_metadata: [{ rssi: -82, snr: 11 }],
      },
    }),
  });
}

const statusPacket = (di1, di2) => ({ Work_mode: "2ACI+2AVI", DI1_status: di1, DI2_status: di2, RO1_status: "OFF" });

function api(path, { method = "GET", body, token = "app-token", origin = "https://dag.github.io" } = {}) {
  return new Request(`${W}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Origin: origin, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test("webhook rejects wrong secret", async () => {
  const res = await worker.fetch(uplinkRequest(statusPacket("L", "H"), { secret: "nope" }), env);
  assert.equal(res.status, 401);
  assert.equal(env.GARAGE.store.size, 0);
});

test("webhook rejects everything when WEBHOOK_SECRET is not configured", async () => {
  delete env.WEBHOOK_SECRET;
  const res = await worker.fetch(uplinkRequest(statusPacket("L", "H"), { secret: "" }), env);
  assert.equal(res.status, 401);
});

test("status uplink updates status endpoint", async () => {
  assert.equal((await worker.fetch(uplinkRequest(statusPacket("L", "H")), env)).status, 200);
  const res = await worker.fetch(api("/api/status"), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://dag.github.io");
  const s = await res.json();
  assert.equal(s.status, "closed");
  assert.equal(s.rssi, -82);
  assert.equal(s.pendingCommand, null);
});

test("API rejects wrong token and foreign origins get no CORS header", async () => {
  assert.equal((await worker.fetch(api("/api/status", { token: "wrong" }), env)).status, 401);
  const res = await worker.fetch(api("/api/status", { origin: "https://evil.example" }), env);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
});

test("preflight succeeds without token", async () => {
  const res = await worker.fetch(
    new Request(`${W}/api/command`, { method: "OPTIONS", headers: { Origin: "https://dag.github.io" } }),
    env,
  );
  assert.equal(res.status, 204);
  assert.match(res.headers.get("Access-Control-Allow-Headers"), /Authorization/);
});

test("open sends exactly one unconfirmed pulse via down/push when closed", async () => {
  await worker.fetch(uplinkRequest(statusPacket("L", "H")), env);
  const res = await worker.fetch(api("/api/command", { method: "POST", body: { action: "open" } }), env);
  assert.equal(res.status, 200);
  assert.equal(downlinkCalls.length, 1);

  const { url, init } = downlinkCalls[0];
  assert.equal(
    url,
    "https://eu1.cloud.thethings.network/api/v3/as/applications/garasjeport-hellargata/webhooks/cf-worker/devices/garasjeport-node/down/push",
  );
  assert.equal(init.headers.Authorization, "Bearer NNSXS.test");
  assert.deepEqual(JSON.parse(init.body), {
    downlinks: [{ f_port: 1, frm_payload: "BQEQA+g=", priority: "NORMAL" }],
  });

  const s = await (await worker.fetch(api("/api/status"), env)).json();
  assert.equal(s.pendingCommand.action, "open");
  assert.equal(s.downlinksToday, 1);
  assert.equal(s.pulsesToday, 1);
  assert.equal(s.pulseLimit, 20);
});

test("close is refused while closed, and nothing is sent", async () => {
  await worker.fetch(uplinkRequest(statusPacket("L", "H")), env);
  const res = await worker.fetch(api("/api/command", { method: "POST", body: { action: "close" } }), env);
  assert.equal(res.status, 409);
  assert.equal(downlinkCalls.length, 0);
});

test("second command within 15 s is rate limited", async () => {
  await worker.fetch(uplinkRequest(statusPacket("H", "H")), env);
  assert.equal((await worker.fetch(api("/api/command", { method: "POST", body: { action: "pulse" } }), env)).status, 200);
  assert.equal((await worker.fetch(api("/api/command", { method: "POST", body: { action: "pulse" } }), env)).status, 429);
  assert.equal(downlinkCalls.length, 1);
});

test("trigger packet does not change status but counts a downlink ACK", async () => {
  await worker.fetch(uplinkRequest(statusPacket("L", "H"), { receivedAt: new Date(Date.now() - 5000).toISOString() }), env);
  await worker.fetch(
    uplinkRequest({ Work_mode: "Exit mode", DI1_flag: "True", DI1_status: "H", DI2_status: "H" }, { confirmed: true }),
    env,
  );
  const s = await (await worker.fetch(api("/api/status"), env)).json();
  assert.equal(s.status, "closed");
  assert.equal(s.downlinksToday, 1);
  assert.equal(s.pulsesToday, 0);
  assert.ok(s.lastTriggerAt > s.updatedAt);
});

test("newer status clears pending command and history logs changes only", async () => {
  await worker.fetch(uplinkRequest(statusPacket("L", "H"), { receivedAt: new Date(Date.now() - 60_000).toISOString() }), env);
  await worker.fetch(uplinkRequest(statusPacket("L", "H"), { receivedAt: new Date(Date.now() - 30_000).toISOString() }), env);
  await worker.fetch(api("/api/command", { method: "POST", body: { action: "open" } }), env);
  await new Promise((r) => setTimeout(r, 5));
  await worker.fetch(uplinkRequest(statusPacket("H", "H")), env);

  const s = await (await worker.fetch(api("/api/status"), env)).json();
  assert.equal(s.status, "moving");
  assert.equal(s.pendingCommand, null);

  const { history } = await (await worker.fetch(api("/api/history"), env)).json();
  assert.deepEqual(history.map((h) => h.type === "command" ? `cmd:${h.action}` : h.status), ["moving", "cmd:open", "closed"]);
});

test("out-of-order uplink is ignored", async () => {
  await worker.fetch(uplinkRequest(statusPacket("H", "L"), { receivedAt: new Date().toISOString() }), env);
  await worker.fetch(uplinkRequest(statusPacket("L", "H"), { receivedAt: new Date(Date.now() - 60_000).toISOString() }), env);
  const s = await (await worker.fetch(api("/api/status"), env)).json();
  assert.equal(s.status, "open");
});

test("TTN failure returns 502 and does not count a downlink", async () => {
  globalThis.fetch = async () => new Response("forbidden", { status: 403 });
  await worker.fetch(uplinkRequest(statusPacket("L", "H")), env);
  const res = await worker.fetch(api("/api/command", { method: "POST", body: { action: "open" } }), env);
  assert.equal(res.status, 502);
  const s = await (await worker.fetch(api("/api/status"), env)).json();
  assert.equal(s.downlinksToday, 0);
  assert.equal(s.pulsesToday, 0);
  assert.equal(s.pendingCommand, null);
});

test("many confirmed-uplink ACKs do not block commands; 20 pulses do", async () => {
  await worker.fetch(uplinkRequest(statusPacket("H", "H"), { receivedAt: new Date(Date.now() - 5000).toISOString() }), env);
  for (let i = 0; i < 30; i++) {
    await worker.fetch(uplinkRequest({ Work_mode: "Exit mode", DI1_flag: "True" }, { confirmed: true }), env);
  }
  assert.equal((await worker.fetch(api("/api/command", { method: "POST", body: { action: "pulse" } }), env)).status, 200);

  const today = [...env.GARAGE.store.keys()].find((k) => k.startsWith("pulses:"));
  env.GARAGE.store.set(today, "20");
  env.GARAGE.store.delete("lastCommand");
  const res = await worker.fetch(api("/api/command", { method: "POST", body: { action: "pulse" } }), env);
  assert.equal(res.status, 429);
  assert.equal((await res.json()).code, "budget");
  assert.equal(downlinkCalls.length, 1);
});
