export const STATUS = {
  CLOSED: "closed",
  OPEN: "open",
  MOVING: "moving",
  OPENING: "opening",
  CLOSING: "closing",
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
    // A full run takes about 26 s. After this long without an end-position
    // trigger the direction is no longer trusted (the door may have been stopped).
    motionMaxMs: 60_000,
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
  if (p.Work_mode === "Exit mode") {
    // Raw fields are kept for logging only, to judge later whether they could drive status.
    const raw = {};
    for (const k of ["DI1_status", "DI2_status", "DI1_flag", "DI2_flag"]) if (k in p) raw[k] = p[k];
    return { kind: "trigger", ...base, raw };
  }
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

// A command is pending until the node reports anything newer: a trigger or a status packet.
export function pendingCommand(lastCommand, state, cfg, now, lastTriggerAt = null) {
  if (!lastCommand) return null;
  const sentAt = Date.parse(lastCommand.sentAt);
  if (now - sentAt > cfg.pendingTimeoutMs) return null;
  if (state?.statusAt && Date.parse(state.statusAt) > sentAt) return null;
  if (lastTriggerAt && Date.parse(lastTriggerAt) > sentAt) return null;
  return lastCommand;
}

// In MOD6 trigger packets, DIx_status "True" marks the input that caused the trigger.
// It is not the input level. Returns "DI1", "DI2" or null if not exactly one.
export function triggerSensor(raw) {
  const hits = ["DI1", "DI2"].filter((d) => raw?.[`${d}_status`] === "True");
  return hits.length === 1 ? hits[0] : null;
}

const IN_MOTION = [STATUS.MOVING, STATUS.OPENING, STATUS.CLOSING];

// Which state the door is in right after a trigger on `sensor`, given the status before it.
// Leaving an end position starts a run; reaching one ends it. Anything else is not inferred.
export function inferFromTrigger(sensor, prevStatus, cfg) {
  if (sensor === cfg.closedSensor) {
    if (prevStatus === STATUS.CLOSED) return STATUS.OPENING;
    if (IN_MOTION.includes(prevStatus)) return STATUS.CLOSED;
  }
  if (sensor === cfg.openSensor) {
    if (prevStatus === STATUS.OPEN) return STATUS.CLOSING;
    if (IN_MOTION.includes(prevStatus)) return STATUS.OPEN;
  }
  return null;
}

// Status shown to the user. Status packets are authoritative; a trigger-inferred
// status (`inferred` = { status, at }) is used while it is newer than the last status
// packet (unconfirmed), and to give a "moving" status packet its direction.
export function effectiveStatus(state, inferred, lastCommand, cfg, now) {
  const base = computeStatus(state, cfg, now);
  if (!inferred) return { status: base, confirmed: true };

  const infAt = Date.parse(inferred.at);
  const statusAt = state?.statusAt ? Date.parse(state.statusAt) : 0;
  const isRun = inferred.status === STATUS.OPENING || inferred.status === STATUS.CLOSING;
  // A pulse after the run started may have stopped or reversed the door.
  const runValid = isRun && now - infAt <= cfg.motionMaxMs
    && !(lastCommand?.sentAt && Date.parse(lastCommand.sentAt) > infAt);

  if (infAt > statusAt) {
    if (!isRun) return { status: inferred.status, confirmed: false };
    return { status: runValid ? inferred.status : STATUS.MOVING, confirmed: false };
  }
  if (base === STATUS.MOVING && runValid) return { status: inferred.status, confirmed: true };
  return { status: base, confirmed: true };
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
