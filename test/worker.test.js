import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker, { GarageState } from "../src/index.js";

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

// Mimics Durable Object storage: values are structured-cloned, get() accepts a key or an array of keys.
function fakeStorage() {
  const map = new Map();
  return {
    map,
    async get(key) {
      if (Array.isArray(key)) return new Map(key.filter((k) => map.has(k)).map((k) => [k, structuredClone(map.get(k))]));
      return map.has(key) ? structuredClone(map.get(key)) : undefined;
    },
    async put(key, value) {
      if (typeof key === "object") for (const [k, v] of Object.entries(key)) map.set(k, structuredClone(v));
      else map.set(key, structuredClone(value));
    },
    async delete(key) {
      return map.delete(key);
    },
    alarm: null,
    async setAlarm(t) {
      this.alarm = t;
    },
    async deleteAlarm() {
      this.alarm = null;
    },
  };
}

// One GarageState instance per test, created on first use like the real runtime.
function fakeNamespace(getEnv) {
  const storage = fakeStorage();
  let instance;
  let ready;
  return {
    storage,
    idFromName: (name) => name,
    get: () => ({
      async fetch(url, init) {
        if (!instance) {
          const state = { storage, blockConcurrencyWhile: (fn) => (ready = fn()) };
          instance = new GarageState(state, getEnv());
        }
        await ready;
        return instance.fetch(new Request(url, init));
      },
    }),
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
  env.GARAGE_DO = fakeNamespace(() => env);
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
  assert.equal(env.GARAGE_DO.storage.map.size, 0);
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

test("open sends exactly one unconfirmed pulse via down/replace when closed", async () => {
  await worker.fetch(uplinkRequest(statusPacket("L", "H")), env);
  const res = await worker.fetch(api("/api/command", { method: "POST", body: { action: "open" } }), env);
  assert.equal(res.status, 200);
  assert.equal(downlinkCalls.length, 1);

  const { url, init } = downlinkCalls[0];
  assert.equal(
    url,
    "https://eu1.cloud.thethings.network/api/v3/as/applications/garasjeport-hellargata/webhooks/cf-worker/devices/garasjeport-node/down/replace",
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

  const { map } = env.GARAGE_DO.storage;
  map.set("counters", { ...map.get("counters"), pulses: 20 });
  map.delete("lastCommand");
  const res = await worker.fetch(api("/api/command", { method: "POST", body: { action: "pulse" } }), env);
  assert.equal(res.status, 429);
  assert.equal((await res.json()).code, "budget");
  assert.equal(downlinkCalls.length, 1);
});

test("existing KV data is copied into the Durable Object on first use", async () => {
  const now = Date.now();
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date(now));
  const kv = env.GARAGE.store;
  kv.set("state", JSON.stringify({ di1: "L", di2: "H", statusAt: new Date(now - 60_000).toISOString(), rssi: -99, snr: 5 }));
  kv.set("history", JSON.stringify([{ t: "2026-11-01T10:00:00Z", type: "status", status: "closed", di1: "L", di2: "H" }]));
  kv.set(`downlinks:${today}`, "7");
  kv.set(`pulses:${today}`, "3");

  const s = await (await worker.fetch(api("/api/status"), env)).json();
  assert.equal(s.status, "closed");
  assert.equal(s.rssi, -99);
  assert.equal(s.downlinksToday, 7);
  assert.equal(s.pulsesToday, 3);
  const { history } = await (await worker.fetch(api("/api/history"), env)).json();
  assert.equal(history.length, 1);

  // KV is not read again after migration.
  kv.set("state", JSON.stringify({ di1: "H", di2: "L", statusAt: new Date(now).toISOString() }));
  env.GARAGE_DO.storage.map.set("migrated", "x");
  assert.equal((await (await worker.fetch(api("/api/status"), env)).json()).status, "closed");
});

test("two simultaneous commands send only one pulse", async () => {
  await worker.fetch(uplinkRequest(statusPacket("L", "H")), env);
  let release;
  globalThis.fetch = async (url, init) => {
    downlinkCalls.push({ url, init });
    await new Promise((r) => (release = r));
    return new Response("{}", { status: 200 });
  };
  const first = worker.fetch(api("/api/command", { method: "POST", body: { action: "open" } }), env);
  await new Promise((r) => setTimeout(r, 5));
  const second = await worker.fetch(api("/api/command", { method: "POST", body: { action: "open" } }), env);
  release();
  assert.equal((await first).status, 200);
  assert.equal(second.status, 429);
  assert.equal(downlinkCalls.length, 1);
});

test("status, trigger and history are visible immediately after the uplink", async () => {
  await worker.fetch(uplinkRequest(statusPacket("L", "H"), { receivedAt: new Date(Date.now() - 30_000).toISOString() }), env);
  await worker.fetch(uplinkRequest({ Work_mode: "Exit mode", DI1_flag: "True" }, { confirmed: true }), env);
  await worker.fetch(uplinkRequest(statusPacket("H", "H")), env);
  const s = await (await worker.fetch(api("/api/status"), env)).json();
  assert.equal(s.status, "moving");
  assert.ok(s.lastTriggerAt);
  const { history } = await (await worker.fetch(api("/api/history"), env)).json();
  assert.deepEqual(history.map((h) => h.type === "trigger" ? "trigger" : h.status), ["moving", "trigger", "closed"]);
  const trig = history[1];
  assert.equal(trig.confirmed, true);
  assert.equal(trig.DI1_flag, "True");
  assert.equal(trig.rssi, -82);
});

// Replays an opening from the real data on 3.11 (closed sensor DI2).
test("app command → trigger → status gives Åpner and Åpen ~7 s before the status packets", async () => {
  env.CLOSED_SENSOR = "DI2";
  const at = (sec) => ({ receivedAt: new Date(Date.now() + sec * 1000).toISOString() });
  const trig = (di1, di2) => ({ Work_mode: "Exit mode", DI1_status: di1, DI2_status: di2, DI1_flag: "True", DI2_flag: "True" });
  const status = async () => (await worker.fetch(api("/api/status"), env)).json();

  await worker.fetch(uplinkRequest(statusPacket("H", "L"), at(-60)), env);
  assert.equal((await status()).status, "closed");
  assert.equal((await worker.fetch(api("/api/command", { method: "POST", body: { action: "open" } }), env)).status, 200);
  assert.equal((await status()).pendingCommand.action, "open");

  await worker.fetch(uplinkRequest(trig("False", "True"), { ...at(2), confirmed: true }), env);
  let s = await status();
  assert.deepEqual([s.status, s.statusConfirmed, s.pendingCommand], ["opening", false, null]);

  await worker.fetch(uplinkRequest(statusPacket("H", "H"), at(9)), env);
  s = await status();
  assert.deepEqual([s.status, s.statusConfirmed], ["opening", true]);

  await worker.fetch(uplinkRequest(trig("True", "False"), { ...at(27), confirmed: true }), env);
  s = await status();
  assert.deepEqual([s.status, s.statusConfirmed], ["open", false]);

  await worker.fetch(uplinkRequest(statusPacket("L", "H"), at(34)), env);
  s = await status();
  assert.deepEqual([s.status, s.statusConfirmed], ["open", true]);

  const { history } = await (await worker.fetch(api("/api/history"), env)).json();
  assert.deepEqual(
    history.filter((h) => h.type !== "trigger").map((h) => h.type === "command" ? `cmd:${h.action}` : h.status),
    ["open", "opening", "cmd:open", "closed"],
  );
  assert.deepEqual(history.filter((h) => h.type === "trigger").map((h) => h.inferred), ["open", "opening"]);
});

test("Lukk is allowed on a trigger-inferred Åpen, and remote-control runs get a direction", async () => {
  env.CLOSED_SENSOR = "DI2";
  const at = (sec) => ({ receivedAt: new Date(Date.now() + sec * 1000).toISOString() });
  const trig = (di1, di2) => ({ Work_mode: "Exit mode", DI1_status: di1, DI2_status: di2 });
  await worker.fetch(uplinkRequest(statusPacket("H", "L"), at(-60)), env);
  await worker.fetch(uplinkRequest(trig("False", "True"), at(-40)), env);
  await worker.fetch(uplinkRequest(statusPacket("H", "H"), at(-33)), env);
  await worker.fetch(uplinkRequest(trig("True", "False"), at(-1)), env);
  const s = await (await worker.fetch(api("/api/status"), env)).json();
  assert.deepEqual([s.status, s.statusConfirmed], ["open", false]);
  assert.equal((await worker.fetch(api("/api/command", { method: "POST", body: { action: "close" } }), env)).status, 200);
});

test("TTN timeout: 504, command recorded as uncertain so the app waits instead of retrying", async () => {
  await worker.fetch(uplinkRequest(statusPacket("L", "H")), env);
  globalThis.fetch = async (url, init) => {
    downlinkCalls.push({ url, init });
    assert.ok(init.signal, "TTN call must have a timeout signal");
    throw new DOMException("The operation timed out.", "TimeoutError");
  };
  const res = await worker.fetch(api("/api/command", { method: "POST", body: { action: "open" } }), env);
  assert.equal(res.status, 504);
  const s = await (await worker.fetch(api("/api/status"), env)).json();
  assert.equal(s.pendingCommand.action, "open");
  assert.equal(s.pendingCommand.uncertain, true);
  assert.equal(s.pulsesToday, 1);
  assert.equal((await worker.fetch(api("/api/command", { method: "POST", body: { action: "open" } }), env)).status, 429);
});

test("unanswered command is reported after 20 s and the button is free again", async () => {
  await worker.fetch(uplinkRequest(statusPacket("H", "L"), { receivedAt: new Date(Date.now() - 60_000).toISOString() }), env);
  await worker.fetch(api("/api/command", { method: "POST", body: { action: "close" } }), env);
  const { map } = env.GARAGE_DO.storage;
  map.set("lastCommand", { ...map.get("lastCommand"), sentAt: new Date(Date.now() - 25_000).toISOString() });
  const s = await (await worker.fetch(api("/api/status"), env)).json();
  assert.equal(s.pendingCommand, null);
  assert.equal(s.unansweredCommand.action, "close");
});

test("downlink webhook: secret required, events logged and exposed", async () => {
  const req = (body, secret = "hook-secret") => new Request(`${W}/ttn/downlink`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Webhook-Secret": secret },
    body: JSON.stringify({ end_device_ids: { device_id: "garasjeport-node" }, received_at: new Date().toISOString(), ...body }),
  });
  assert.equal((await worker.fetch(req({ downlink_sent: { f_port: 1 } }, "nope"), env)).status, 401);
  assert.equal((await worker.fetch(req({ downlink_queued: { f_port: 1 } }), env)).status, 200);
  assert.equal((await worker.fetch(req({ downlink_failed: { downlink: { f_port: 1 }, error: { namespace: "pkg/gs", name: "too_late" } } }), env)).status, 200);
  const s = await (await worker.fetch(api("/api/status"), env)).json();
  assert.deepEqual([s.lastDownlink.event, s.lastDownlink.error], ["failed", "pkg/gs:too_late"]);
  const { history } = await (await worker.fetch(api("/api/history"), env)).json();
  assert.deepEqual(history.map((h) => `${h.type}:${h.event}`), ["downlink:failed", "downlink:queued"]);
});

test("ntfy: åpen port varsles via alarmen, pause fra varselet virker, og lukket gir melding", async () => {
  env.NTFY_TOPIC = "garasje-test";
  env.ALERT_ACTION_KEY = "pause-key";
  env.WORKER_URL = W;
  env.APP_URL = "https://dag.github.io/garasjeport/";
  const ntfy = () => downlinkCalls.filter((c) => c.url === "https://ntfy.sh").map((c) => JSON.parse(c.init.body));

  const t = Date.now();
  await worker.fetch(uplinkRequest(statusPacket("H", "L"), { receivedAt: new Date(t).toISOString() }), env);
  const storage = env.GARAGE_DO.storage;
  assert.ok(Math.abs(storage.alarm - (t + 15 * 60_000)) < 1000);
  assert.equal(ntfy().length, 0);

  // Alarmen går 15 min senere. Hent instansen via en status-forespørsel og kall alarm() med falsk klokke.
  const realNow = Date.now;
  Date.now = () => t + 16 * 60_000;
  try {
    let s = await (await worker.fetch(api("/api/status"), env)).json();
    assert.equal(s.status, "open");
    const instance = await getInstance();
    await instance.alarm();
    assert.equal(ntfy().length, 1);
    assert.equal(ntfy()[0].title, "Garasjeporten står åpen");

    // Pause fra varselknappen: feil nøkkel avvises, riktig nøkkel virker
    const bad = await worker.fetch(new Request(`${W}/alert/snooze`, { method: "POST", headers: { Authorization: "Bearer app-token" } }), env);
    assert.equal(bad.status, 401);
    const ok = await worker.fetch(new Request(`${W}/alert/snooze`, { method: "POST", headers: { Authorization: "Bearer pause-key" } }), env);
    assert.equal(ok.status, 200);
    s = await (await worker.fetch(api("/api/status"), env)).json();
    assert.equal(s.alertsSnoozed, true);

    // Påminnelsen en time senere kommer ikke
    Date.now = () => t + 80 * 60_000;
    await worker.fetch(uplinkRequest(statusPacket("H", "L"), { receivedAt: new Date(t + 80 * 60_000).toISOString() }), env);
    await instance.alarm();
    assert.equal(ntfy().length, 1);

    // Lukket: «lukket»-melding, pausen nullstilles
    await worker.fetch(uplinkRequest(statusPacket("L", "H"), { receivedAt: new Date(t + 81 * 60_000).toISOString() }), env);
    assert.equal(ntfy().length, 2);
    assert.equal(ntfy()[1].title, "Garasjeporten er lukket");
    s = await (await worker.fetch(api("/api/status"), env)).json();
    assert.equal(s.alertsSnoozed, false);

    // Pause fra appen når porten er lukket gir 409
    const res = await worker.fetch(api("/api/alerts", { method: "POST", body: { action: "snooze" } }), env);
    assert.equal(res.status, 409);
  } finally {
    Date.now = realNow;
  }

  async function getInstance() {
    // fakeNamespace oppretter én instans; GarageState.prototype brukes via en liten omvei
    let captured;
    const orig = GarageState.prototype.fetch;
    GarageState.prototype.fetch = function (req) { captured = this; return orig.call(this, req); };
    await worker.fetch(api("/api/status"), env);
    GarageState.prototype.fetch = orig;
    return captured;
  }
});

test("uten NTFY_TOPIC sendes ingen varsler og ingen alarm settes", async () => {
  await worker.fetch(uplinkRequest(statusPacket("H", "L")), env);
  assert.equal(env.GARAGE_DO.storage.alarm, null);
  const s = await (await worker.fetch(api("/api/status"), env)).json();
  assert.equal(s.alertsEnabled, false);
});
