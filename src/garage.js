import { checkCommand, computeStatus, osloDate, pendingCommand, readConfig } from "./logic.js";

const HISTORY_MAX = 300;
const KV_KEYS = ["state", "lastTrigger", "lastCommand", "history"];

// One instance (idFromName("garage")) holds all state. A Durable Object handles
// requests one at a time against strongly consistent storage, so the app always
// sees the newest status and concurrent writes cannot overwrite each other.
export class GarageState {
  constructor(state, env) {
    this.storage = state.storage;
    this.env = env;
    this.sending = false;
    state.blockConcurrencyWhile(() => this.migrateFromKV());
  }

  // One-time copy of the data that lived in Workers KV before the Durable Object.
  async migrateFromKV() {
    if ((await this.storage.get("migrated")) || !this.env.GARAGE) return;
    const now = Date.now();
    const today = osloDate(now);
    const entries = {};
    for (const key of KV_KEYS) {
      const value = await this.env.GARAGE.get(key, "json");
      if (value != null) entries[key] = value;
    }
    entries.counters = {
      date: today,
      downlinks: Number((await this.env.GARAGE.get(`downlinks:${today}`)) || 0),
      pulses: Number((await this.env.GARAGE.get(`pulses:${today}`)) || 0),
    };
    entries.migrated = new Date(now).toISOString();
    await this.storage.put(entries);
  }

  async fetch(request) {
    const { op, ...args } = await request.json();
    const now = Date.now();
    if (op === "uplink") return this.uplink(args.up, now);
    if (op === "status") return reply(await this.status(now));
    if (op === "history") return reply({ history: (await this.storage.get("history")) ?? [] });
    if (op === "command") return this.command(args.action, now);
    return reply({ error: "Ukjent operasjon." }, 400);
  }

  async uplink(up, now) {
    // Each confirmed uplink costs one downlink (the ACK). Counted for information only.
    if (up.confirmed) await this.increment(now, { downlinks: 1 });

    if (up.kind === "trigger") {
      await this.storage.put("lastTrigger", { receivedAt: up.receivedAt });
      // Logged for timing analysis (trigger → status). The app hides these entries.
      await this.appendHistory({
        t: up.receivedAt,
        type: "trigger",
        confirmed: up.confirmed,
        fCnt: up.fCnt,
        rssi: up.rssi,
        snr: up.snr,
        ...up.raw,
      });
      return reply({ result: "ok" });
    }

    const cfg = readConfig(this.env);
    const prev = await this.storage.get("state");
    if (prev?.statusAt && Date.parse(up.receivedAt) <= Date.parse(prev.statusAt)) {
      return reply({ result: "stale" });
    }
    const next = {
      di1: up.di1,
      di2: up.di2,
      statusAt: up.receivedAt,
      fCnt: up.fCnt,
      rssi: up.rssi,
      snr: up.snr,
    };
    await this.storage.put("state", next);

    const prevStatus = prev ? computeStatus(prev, cfg, Date.parse(prev.statusAt)) : null;
    const nextStatus = computeStatus(next, cfg, Date.parse(next.statusAt));
    if (prevStatus !== nextStatus) {
      await this.appendHistory({ t: up.receivedAt, type: "status", status: nextStatus, di1: up.di1, di2: up.di2 });
    }
    return reply({ result: "ok" });
  }

  async status(now) {
    const cfg = readConfig(this.env);
    const data = await this.storage.get(["state", "lastTrigger", "lastCommand"]);
    const state = data.get("state");
    const counters = await this.counters(now);
    return {
      status: computeStatus(state, cfg, now),
      di1: state?.di1 ?? null,
      di2: state?.di2 ?? null,
      closedSensor: cfg.closedSensor,
      openSensor: cfg.openSensor,
      updatedAt: state?.statusAt ?? null,
      rssi: state?.rssi ?? null,
      snr: state?.snr ?? null,
      lastTriggerAt: data.get("lastTrigger")?.receivedAt ?? null,
      pendingCommand: pendingCommand(data.get("lastCommand"), state, cfg, now),
      downlinksToday: counters.downlinks,
      pulsesToday: counters.pulses,
      pulseLimit: cfg.pulseLimit,
      serverTime: new Date(now).toISOString(),
    };
  }

  async command(action, now) {
    // The TTN call awaits the network, and other requests may run meanwhile.
    // This flag stops a second command from passing the checks before the first is recorded.
    if (this.sending) {
      return reply({ error: "En kommando sendes allerede. Vent litt.", code: "rate_limited" }, 429);
    }
    this.sending = true;
    try {
      const cfg = readConfig(this.env);
      const state = await this.storage.get("state");
      const lastCommand = await this.storage.get("lastCommand");
      const { pulses } = await this.counters(now);
      const status = computeStatus(state, cfg, now);

      const check = checkCommand(action, status, { now, lastSentAt: lastCommand?.sentAt, pulsesToday: pulses }, cfg);
      if (!check.ok) return reply({ error: check.message, code: check.code, status }, check.http);

      const res = await sendPulse(this.env);
      if (!res.ok) {
        console.error("TTN downlink failed", res.status, await res.text());
        return reply({ error: `TTN avviste kommandoen (HTTP ${res.status}). Ingen puls sendt.` }, 502);
      }

      const command = { action, sentAt: new Date(now).toISOString(), statusBefore: status };
      await this.storage.put("lastCommand", command);
      await this.increment(now, { downlinks: 1, pulses: 1 });
      await this.appendHistory({ t: command.sentAt, type: "command", action, statusBefore: status });
      return reply({ ok: true, pendingCommand: command });
    } finally {
      this.sending = false;
    }
  }

  // Daily counters per Oslo date: downlinks (incl. ACKs, informational) and
  // pulses (relay pulses from the app, enforced by PULSE_DAILY_LIMIT).
  async counters(now) {
    const today = osloDate(now);
    const c = await this.storage.get("counters");
    return c?.date === today ? c : { date: today, downlinks: 0, pulses: 0 };
  }

  async increment(now, add) {
    const c = { ...(await this.counters(now)) };
    for (const [k, v] of Object.entries(add)) c[k] += v;
    await this.storage.put("counters", c);
  }

  async appendHistory(entry) {
    const history = (await this.storage.get("history")) ?? [];
    history.unshift(entry);
    await this.storage.put("history", history.slice(0, HISTORY_MAX));
  }
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

function reply(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
