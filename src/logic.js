export const STATUS = {
  CLOSED: "closed",
  OPEN: "open",
  MOVING: "moving",
  ERROR: "error",
  UNKNOWN: "unknown",
};

export const ACTIONS = ["open", "close", "pulse"];

export function readConfig(env) {
  const closedSensor = env.CLOSED_SENSOR === "DI2" ? "DI2" : "DI1";
  return {
    closedSensor,
    openSensor: closedSensor === "DI1" ? "DI2" : "DI1",
    staleMs: Number(env.STALE_MINUTES || 30) * 60_000,
    pulseLimit: Number(env.PULSE_DAILY_LIMIT || 20),
    pulseIntervalMs: Number(env.PULSE_MIN_INTERVAL_SECONDS || 15) * 1000,
    pendingTimeoutMs: 3 * 60_000,
  };
}

const level = (state, sensor) => (sensor === "DI1" ? state.di1 : state.di2);

export function computeStatus(state, cfg, now) {
  if (!state?.statusAt) return STATUS.UNKNOWN;
  if (now - Date.parse(state.statusAt) > cfg.staleMs) return STATUS.UNKNOWN;
  const closed = level(state, cfg.closedSensor);
  const open = level(state, cfg.openSensor);
  if (closed === "L" && open === "H") return STATUS.CLOSED;
  if (closed === "H" && open === "L") return STATUS.OPEN;
  if (closed === "H" && open === "H") return STATUS.MOVING;
  if (closed === "L" && open === "L") return STATUS.ERROR;
  return STATUS.UNKNOWN;
}

const isLevel = (v) => v === "H" || v === "L";

// MOD6 trigger packets (and AB 06 poll replies) carry DI flags that must not drive status.
export function parseUplink(body, deviceId) {
  if (body?.end_device_ids?.device_id !== deviceId) return { kind: "ignore" };
  const msg = body.uplink_message;
  const p = msg?.decoded_payload;
  if (!msg || msg.f_port !== 2 || !p) return { kind: "ignore" };

  const receivedAt = msg.received_at || body.received_at || new Date().toISOString();
  const rx = msg.rx_metadata?.[0] ?? {};
  const base = {
    receivedAt,
    fCnt: msg.f_cnt ?? null,
    rssi: rx.rssi ?? null,
    snr: rx.snr ?? null,
    confirmed: msg.confirmed === true,
  };

  if (p.Work_mode === "2ACI+2AVI" && isLevel(p.DI1_status) && isLevel(p.DI2_status)) {
    return { kind: "status", ...base, di1: p.DI1_status, di2: p.DI2_status };
  }
  if (p.Work_mode === "Exit mode") return { kind: "trigger", ...base };
  return { kind: "ignore" };
}

export function checkCommand(action, status, ctx, cfg) {
  if (!ACTIONS.includes(action)) {
    return { ok: false, http: 400, code: "bad_action", message: "Ukjent handling." };
  }
  if (action === "open" && status !== STATUS.CLOSED) {
    return { ok: false, http: 409, code: "wrong_state", message: "Porten er ikke lukket. «Åpne» sender bare puls når porten er lukket." };
  }
  if (action === "close" && status !== STATUS.OPEN) {
    return { ok: false, http: 409, code: "wrong_state", message: "Porten er ikke åpen. «Lukk» sender bare puls når porten er åpen." };
  }
  if (ctx.lastSentAt && ctx.now - Date.parse(ctx.lastSentAt) < cfg.pulseIntervalMs) {
    const wait = Math.ceil((cfg.pulseIntervalMs - (ctx.now - Date.parse(ctx.lastSentAt))) / 1000);
    return { ok: false, http: 429, code: "rate_limited", message: `Vent ${wait} s før neste kommando.` };
  }
  if (ctx.pulsesToday >= cfg.pulseLimit) {
    return { ok: false, http: 429, code: "budget", message: `Dagens grense på ${cfg.pulseLimit} relépulser er nådd. Prøv igjen etter midnatt.` };
  }
  return { ok: true };
}

export function pendingCommand(lastCommand, state, cfg, now) {
  if (!lastCommand) return null;
  const sentAt = Date.parse(lastCommand.sentAt);
  if (now - sentAt > cfg.pendingTimeoutMs) return null;
  if (state?.statusAt && Date.parse(state.statusAt) > sentAt) return null;
  return lastCommand;
}

export function osloDate(now) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date(now));
}

export async function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
