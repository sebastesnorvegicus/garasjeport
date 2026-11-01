import {
  checkCommand,
  computeStatus,
  osloDate,
  parseUplink,
  pendingCommand,
  readConfig,
  safeEqual,
} from "./logic.js";

const HISTORY_MAX = 100;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/ttn/uplink" && request.method === "POST") {
        return await handleUplink(request, env);
      }
      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, env, url.pathname);
      }
      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error(err);
      return json({ error: "Intern feil i Workeren." }, 500, corsHeaders(request, env));
    }
  },
};

async function handleUplink(request, env) {
  if (!(await safeEqual(request.headers.get("X-Webhook-Secret"), env.WEBHOOK_SECRET))) {
    return new Response("Unauthorized", { status: 401 });
  }
  const body = await request.json().catch(() => null);
  const up = parseUplink(body, env.TTN_DEVICE_ID);
  if (up.kind === "ignore") return new Response("ignored");

  const now = Date.now();
  // Each confirmed uplink costs one downlink (the ACK) from the fair-use budget.
  if (up.confirmed) await incrementCounter(env, "downlinks", now);

  if (up.kind === "trigger") {
    await env.GARAGE.put("lastTrigger", JSON.stringify({ receivedAt: up.receivedAt }));
    return new Response("ok");
  }

  const cfg = readConfig(env);
  const prev = await getJSON(env, "state");
  if (prev?.statusAt && Date.parse(up.receivedAt) <= Date.parse(prev.statusAt)) {
    return new Response("stale");
  }
  const next = {
    di1: up.di1,
    di2: up.di2,
    statusAt: up.receivedAt,
    fCnt: up.fCnt,
    rssi: up.rssi,
    snr: up.snr,
  };
  await env.GARAGE.put("state", JSON.stringify(next));

  const prevStatus = prev ? computeStatus(prev, cfg, Date.parse(prev.statusAt)) : null;
  const nextStatus = computeStatus(next, cfg, Date.parse(next.statusAt));
  if (prevStatus !== nextStatus) {
    await appendHistory(env, { t: up.receivedAt, type: "status", status: nextStatus, di1: up.di1, di2: up.di2 });
  }
  return new Response("ok");
}

async function handleApi(request, env, path) {
  const cors = corsHeaders(request, env);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!(await safeEqual(token, env.APP_TOKEN))) {
    return json({ error: "Feil eller manglende tilgangstoken." }, 401, cors);
  }

  if (path === "/api/status" && request.method === "GET") return json(await getStatus(env), 200, cors);
  if (path === "/api/history" && request.method === "GET") {
    return json({ history: (await getJSON(env, "history")) ?? [] }, 200, cors);
  }
  if (path === "/api/command" && request.method === "POST") return await handleCommand(request, env, cors);
  return json({ error: "Ukjent API-sti." }, 404, cors);
}

async function getStatus(env) {
  const now = Date.now();
  const cfg = readConfig(env);
  const [state, lastTrigger, lastCommand, downlinksToday, pulsesToday] = await Promise.all([
    getJSON(env, "state"),
    getJSON(env, "lastTrigger"),
    getJSON(env, "lastCommand"),
    getCounter(env, "downlinks", now),
    getCounter(env, "pulses", now),
  ]);
  return {
    status: computeStatus(state, cfg, now),
    di1: state?.di1 ?? null,
    di2: state?.di2 ?? null,
    closedSensor: cfg.closedSensor,
    openSensor: cfg.openSensor,
    updatedAt: state?.statusAt ?? null,
    rssi: state?.rssi ?? null,
    snr: state?.snr ?? null,
    lastTriggerAt: lastTrigger?.receivedAt ?? null,
    pendingCommand: pendingCommand(lastCommand, state, cfg, now),
    downlinksToday,
    pulsesToday,
    pulseLimit: cfg.pulseLimit,
    serverTime: new Date(now).toISOString(),
  };
}

async function handleCommand(request, env, cors) {
  const body = await request.json().catch(() => null);
  const action = body?.action;
  const now = Date.now();
  const cfg = readConfig(env);
  const [state, lastCommand, pulsesToday] = await Promise.all([
    getJSON(env, "state"),
    getJSON(env, "lastCommand"),
    getCounter(env, "pulses", now),
  ]);
  const status = computeStatus(state, cfg, now);

  const check = checkCommand(action, status, { now, lastSentAt: lastCommand?.sentAt, pulsesToday }, cfg);
  if (!check.ok) return json({ error: check.message, code: check.code, status }, check.http, cors);

  const res = await sendPulse(env);
  if (!res.ok) {
    console.error("TTN downlink failed", res.status, await res.text());
    return json({ error: `TTN avviste kommandoen (HTTP ${res.status}). Ingen puls sendt.` }, 502, cors);
  }

  const command = { action, sentAt: new Date(now).toISOString(), statusBefore: status };
  await Promise.all([
    env.GARAGE.put("lastCommand", JSON.stringify(command)),
    incrementCounter(env, "downlinks", now),
    incrementCounter(env, "pulses", now),
    appendHistory(env, { t: command.sentAt, type: "command", action, statusBefore: status }),
  ]);
  return json({ ok: true, pendingCommand: command }, 200, cors);
}

function sendPulse(env) {
  const url =
    `${env.TTN_BASE_URL}/api/v3/as/applications/${env.TTN_APP_ID}` +
    `/webhooks/${env.TTN_WEBHOOK_ID}/devices/${env.TTN_DEVICE_ID}/down/push`;
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.TTN_API_KEY}`,
      "Content-Type": "application/json",
      "User-Agent": "garasjeport-worker/1.0",
    },
    body: JSON.stringify({
      downlinks: [{ f_port: 1, frm_payload: env.PULSE_PAYLOAD, priority: "NORMAL" }],
    }),
  });
}

async function getJSON(env, key) {
  return env.GARAGE.get(key, "json");
}

// Daily counters per Oslo date: "downlinks" (all downlinks incl. ACKs, informational)
// and "pulses" (relay pulses sent by the app, enforced by PULSE_DAILY_LIMIT).
async function getCounter(env, name, now) {
  return Number((await env.GARAGE.get(`${name}:${osloDate(now)}`)) || 0);
}

async function incrementCounter(env, name, now) {
  const key = `${name}:${osloDate(now)}`;
  const count = Number((await env.GARAGE.get(key)) || 0) + 1;
  await env.GARAGE.put(key, String(count), { expirationTtl: 3 * 86400 });
}

async function appendHistory(env, entry) {
  const history = (await getJSON(env, "history")) ?? [];
  history.unshift(entry);
  await env.GARAGE.put("history", JSON.stringify(history.slice(0, HISTORY_MAX)));
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = (env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
  const headers = { Vary: "Origin" };
  if (origin && allowed.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type";
    headers["Access-Control-Max-Age"] = "86400";
  }
  return headers;
}

function json(data, status, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders },
  });
}
