import {
  checkCommand,
  computeStatus,
  effectiveStatus,
  inferFromTrigger,
  osloDate,
  pendingCommand,
  readConfig,
  unansweredCommand,
  triggerSensor,
} from "./logic.js";

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
    if (op === "downlink") return this.downlink(args.ev);
    return reply({ error: "Ukjent operasjon." }, 400);
  }

  async uplink(up, now) {
    console.log(JSON.stringify({ ev: "uplink", kind: up.kind, fCnt: up.fCnt, receivedAt: up.receivedAt, di1: up.di1, di2: up.di2, raw: up.raw }));
    // Each confirmed uplink costs one downlink (the ACK). Counted for information only.
    if (up.confirmed) await this.increment(now, { downlinks: 1 });

    const cfg = readConfig(this.env);
    if (up.kind === "trigger") return this.trigger(up, cfg);

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

    // History records the status as the app shows it, so a run is logged as Åpner/Lukker.
    const at = Date.parse(next.statusAt);
    const { inferred, lastCommand } = await this.load(["inferred", "lastCommand"]);
    const nextStatus = effectiveStatus(next, inferred, lastCommand, cfg, at).status;
    const logged = (await this.storage.get("loggedStatus"))
      ?? (prev ? computeStatus(prev, cfg, Date.parse(prev.statusAt)) : null);
    if (logged !== nextStatus) {
      await this.appendHistory({ t: up.receivedAt, type: "status", status: nextStatus, di1: up.di1, di2: up.di2 });
      await this.storage.put("loggedStatus", nextStatus);
    }
    return reply({ result: "ok" });
  }

  // A trigger arrives about 7 s before the status packet that follows it. Combined with the
  // status before it, the input that fired tells whether the door left or reached an end.
  async trigger(up, cfg) {
    const at = Date.parse(up.receivedAt);
    const { state, inferred, lastCommand } = await this.load(["state", "inferred", "lastCommand"]);
    await this.storage.put("lastTrigger", { receivedAt: up.receivedAt });

    let result = null;
    if (!state?.statusAt || at > Date.parse(state.statusAt)) {
      const before = effectiveStatus(state, inferred, lastCommand, cfg, at).status;
      result = inferFromTrigger(triggerSensor(up.raw), before, cfg);
      if (result) await this.storage.put("inferred", { status: result, at: up.receivedAt });
      else await this.storage.delete("inferred");
    }

    // Logged for timing analysis. The app hides these entries.
    await this.appendHistory({
      t: up.receivedAt,
      type: "trigger",
      inferred: result,
      confirmed: up.confirmed,
      fCnt: up.fCnt,
      rssi: up.rssi,
      snr: up.snr,
      ...up.raw,
    });
    return reply({ result: "ok" });
  }

  async load(keys) {
    const map = await this.storage.get(keys);
    return Object.fromEntries(keys.map((k) => [k, map.get(k)]));
  }

  async status(now) {
    const cfg = readConfig(this.env);
    const { state, lastTrigger, lastCommand, inferred, lastDownlink } =
      await this.load(["state", "lastTrigger", "lastCommand", "inferred", "lastDownlink"]);
    const counters = await this.counters(now);
    const eff = effectiveStatus(state, inferred, lastCommand, cfg, now);
    return {
      status: eff.status,
      // false while the status comes from a trigger and the status packet has not arrived yet
      statusConfirmed: eff.confirmed,
      di1: state?.di1 ?? null,
      di2: state?.di2 ?? null,
      closedSensor: cfg.closedSensor,
      openSensor: cfg.openSensor,
      updatedAt: state?.statusAt ?? null,
      rssi: state?.rssi ?? null,
      snr: state?.snr ?? null,
      lastTriggerAt: lastTrigger?.receivedAt ?? null,
      pendingCommand: pendingCommand(lastCommand, state, cfg, now, lastTrigger?.receivedAt),
      unansweredCommand: unansweredCommand(lastCommand, state, cfg, now, lastTrigger?.receivedAt),
      lastDownlink: lastDownlink ?? null,
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
      const { state, lastCommand, inferred } = await this.load(["state", "lastCommand", "inferred"]);
      const { pulses } = await this.counters(now);
      const { status } = effectiveStatus(state, inferred, lastCommand, cfg, now);

      const check = checkCommand(action, status, { now, lastSentAt: lastCommand?.sentAt, pulsesToday: pulses }, cfg);
      if (!check.ok) return reply({ error: check.message, code: check.code, status }, check.http);

      const command = { action, sentAt: new Date(now).toISOString(), statusBefore: status };
      let res;
      try {
        res = await sendPulse(this.env, cfg.ttnTimeoutMs);
      } catch (err) {
        // No answer from TTN in time. The pulse may still go out, so record the command:
        // that keeps the rate limit and makes the app wait for a reaction.
        console.error(JSON.stringify({ ev: "command", action, result: "ttn_timeout", error: String(err) }));
        await this.record({ ...command, uncertain: true }, now);
        return reply({ error: "TTN svarte ikke i tide. Pulsen kan likevel ha blitt sendt, så vent og se om porten reagerer." }, 504);
      }
      if (!res.ok) {
        console.error(JSON.stringify({ ev: "command", action, result: "ttn_rejected", status: res.status, body: await res.text() }));
        return reply({ error: `TTN avviste kommandoen (HTTP ${res.status}). Ingen puls sendt.` }, 502);
      }
      console.log(JSON.stringify({ ev: "command", action, result: "ok", statusBefore: status }));
      await this.record(command, now);
      return reply({ ok: true, pendingCommand: command });
    } finally {
      this.sending = false;
    }
  }

  async record(command, now) {
    await this.storage.put("lastCommand", command);
    await this.increment(now, { downlinks: 1, pulses: 1 });
    await this.appendHistory({ t: command.sentAt, type: "command", ...command });
  }

  // TTN reports what happened to a downlink: queued, sent by a gateway, failed, ...
  async downlink(ev) {
    console.log(JSON.stringify({ ev: "downlink", ...ev }));
    await this.storage.put("lastDownlink", ev);
    await this.appendHistory({ t: ev.at, type: "downlink", event: ev.event, fPort: ev.fPort, error: ev.error });
    return reply({ result: "ok" });
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

// down/replace (not push): a new command replaces one still waiting in TTN's queue,
// so a delayed pulse can never be followed by a second one.
function sendPulse(env, timeoutMs) {
  const url =
    `${env.TTN_BASE_URL}/api/v3/as/applications/${env.TTN_APP_ID}` +
    `/webhooks/${env.TTN_WEBHOOK_ID}/devices/${env.TTN_DEVICE_ID}/down/replace`;
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
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function reply(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
