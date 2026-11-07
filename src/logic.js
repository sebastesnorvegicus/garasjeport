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
    // The door normally reacts within ~2.5 s. After this the app unlocks and says it got no reaction.
    pendingTimeoutMs: 20_000,
    unansweredShowMs: 10 * 60_000,
    ttnTimeoutMs: 10_000,
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

// The node reacted to a command if it reported anything newer: a trigger or a status packet.
function reacted(lastCommand, state, lastTriggerAt) {
  const sentAt = Date.parse(lastCommand.sentAt);
  return (state?.statusAt && Date.parse(state.statusAt) > sentAt)
    || (lastTriggerAt && Date.parse(lastTriggerAt) > sentAt);
}

// A command is pending until the node reacts, for at most pendingTimeoutMs.
export function pendingCommand(lastCommand, state, cfg, now, lastTriggerAt = null) {
  if (!lastCommand) return null;
  if (now - Date.parse(lastCommand.sentAt) > cfg.pendingTimeoutMs) return null;
  return reacted(lastCommand, state, lastTriggerAt) ? null : lastCommand;
}

// The last command got no reaction within pendingTimeoutMs. Shown for a while so the user can retry.
export function unansweredCommand(lastCommand, state, cfg, now, lastTriggerAt = null) {
  if (!lastCommand) return null;
  const age = now - Date.parse(lastCommand.sentAt);
  if (age <= cfg.pendingTimeoutMs || age > cfg.unansweredShowMs) return null;
  return reacted(lastCommand, state, lastTriggerAt) ? null : lastCommand;
}

const DOWNLINK_EVENTS = {
  downlink_queued: "queued",
  downlink_sent: "sent",
  downlink_failed: "failed",
  downlink_ack: "ack",
  downlink_nack: "nack",
  downlink_queue_invalidated: "invalidated",
};

// TTN webhook messages about our downlinks: whether a pulse was queued, sent by a gateway, or failed.
export function parseDownlinkEvent(body, deviceId) {
  if (body?.end_device_ids?.device_id !== deviceId) return null;
  const key = Object.keys(DOWNLINK_EVENTS).find((k) => body[k]);
  if (!key) return null;
  const msg = body[key];
  const down = msg.downlink ?? msg;
  const err = msg.error;
  return {
    event: DOWNLINK_EVENTS[key],
    at: body.received_at || new Date().toISOString(),
    fPort: down?.f_port ?? null,
    error: err ? ([err.namespace, err.name].filter(Boolean).join(":") || err.message_format || "ukjent") : null,
  };
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

// ---------------------------------------------------------------------------
// Varsler (ntfy) når porten står åpen, og når noden har vært stille lenge.

export function readAlertConfig(env) {
  const minutes = (v, d) => (v === undefined || v === "" ? d : Number(v)) * 60_000;
  const evening = /^(\d{1,2}):(\d{2})$/.exec(env.ALERT_EVENING ?? "22:00");
  return {
    enabled: !!env.NTFY_TOPIC,
    ntfyUrl: (env.NTFY_URL || "https://ntfy.sh").replace(/\/+$/, ""),
    topic: env.NTFY_TOPIC,
    ntfyToken: env.NTFY_TOKEN || null,
    actionKey: env.ALERT_ACTION_KEY || null,
    workerUrl: (env.WORKER_URL || "").replace(/\/+$/, ""),
    appUrl: env.APP_URL || "",
    openMs: minutes(env.ALERT_OPEN_MINUTES, 15),
    reminderMs: minutes(env.ALERT_REMINDER_MINUTES, 60),
    staleMs: minutes(env.ALERT_STALE_MINUTES, 60),
    // [time, minutt] i norsk tid, eller null hvis kveldsvarselet er slått av
    evening: evening ? [Number(evening[1]), Number(evening[2])] : null,
  };
}

// Minutter Oslo ligger foran UTC på tidspunktet t (60 vinter, 120 sommer).
function osloOffsetMs(t) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Oslo", timeZoneName: "shortOffset" })
    .formatToParts(new Date(t)).find((p) => p.type === "timeZoneName").value; // "GMT+1"
  const m = /GMT([+-]\d+)(?::(\d+))?/.exec(name);
  return m ? (Number(m[1]) * 60 + Math.sign(Number(m[1])) * Number(m[2] || 0)) * 60_000 : 0;
}

// Første gang klokka i Oslo viser hh:mm etter tidspunktet t.
export function nextOsloTime(t, [hh, mm]) {
  const [y, mo, d] = osloDate(t).split("-").map(Number);
  for (let add = 0; add < 3; add++) {
    const guess = Date.UTC(y, mo - 1, d + add, hh, mm);
    const at = guess - osloOffsetMs(guess);
    if (at > t) return at;
  }
  return null;
}

export function osloClock(t) {
  return new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit" }).format(new Date(t));
}

const NOT_CLOSED = [STATUS.OPEN, STATUS.MOVING, STATUS.OPENING, STATUS.CLOSING, STATUS.ERROR];

// Bestemmer hvilke varsler som skal sendes nå, og når neste sjekk må skje.
// alert = { openSince, firstAt, reminderAt, eveningAt, snoozedAt, staleAt, lastStatus } (ms)
// Regler for én åpning:
//   - første varsel etter openMs, én påminnelse reminderMs etter det, så stille
//   - «Jeg er i garasjen» (snoozedAt) stopper disse to til porten lukkes
//   - kveldsvarsel én gang ved første «evening» etter at porten ble åpnet, også om pauset
//   - «lukket»-melding bare hvis det er sendt varsel om denne åpningen
// I tillegg: varsel én gang når noden har vært stille i staleMs, og når kontakten er tilbake.
export function planAlerts({ alert, status, lastPacketAt, now, cfg }) {
  const a = { ...(alert ?? {}) };
  const messages = [];
  const stale = lastPacketAt == null || now - lastPacketAt >= cfg.staleMs;

  if (stale) {
    if (lastPacketAt != null && !a.staleAt) {
      messages.push({ kind: "stale", lastPacketAt, lastStatus: a.lastStatus ?? null });
      a.staleAt = now;
    }
  } else if (a.staleAt) {
    messages.push({ kind: "contact", status });
    delete a.staleAt;
  }

  if (status === STATUS.CLOSED) {
    if (a.openSince && (a.firstAt || a.reminderAt || a.eveningAt)) {
      messages.push({ kind: "closed", openSince: a.openSince });
    }
    for (const k of ["openSince", "firstAt", "reminderAt", "eveningAt", "snoozedAt"]) delete a[k];
  } else if (NOT_CLOSED.includes(status)) {
    a.openSince ??= now;
    const due = [];
    const eveningTime = cfg.evening ? nextOsloTime(a.openSince, cfg.evening) : null;
    if (eveningTime && !a.eveningAt && now >= eveningTime && now >= a.openSince + cfg.openMs) due.push("evening");
    if (!a.snoozedAt) {
      if (!a.firstAt && now >= a.openSince + cfg.openMs) due.push("open");
      else if (a.firstAt && !a.reminderAt && now >= a.firstAt + cfg.reminderMs) due.push("reminder");
    }
    if (due.length) {
      // Ett varsel om gangen. Kveldsvarselet er det siste, så det tar over for de andre.
      const kind = due[0];
      messages.push({ kind, status, openSince: a.openSince, eveningTime: kind === "evening" ? null : eveningTime });
      if (due.includes("evening")) a.eveningAt = now;
      if (due.includes("open")) a.firstAt = now;
      if (due.includes("reminder")) a.reminderAt = now;
      // Etter kveldsvarselet kommer ingen flere varsler om denne åpningen.
      if (kind === "evening") { a.firstAt ??= now; a.reminderAt ??= now; }
    }
  }
  // Ukjent status (ingen fersk melding): ingen åpen-varsler. Stillhets-varselet dekker det.

  if (status !== STATUS.UNKNOWN) a.lastStatus = status;

  // Neste tidspunkt noe kan bli aktuelt.
  const next = [];
  if (lastPacketAt != null && !a.staleAt) next.push(lastPacketAt + cfg.staleMs);
  if (a.openSince) {
    if (!a.snoozedAt && !a.firstAt) next.push(a.openSince + cfg.openMs);
    if (!a.snoozedAt && a.firstAt && !a.reminderAt) next.push(a.firstAt + cfg.reminderMs);
    if (cfg.evening && !a.eveningAt) {
      const ev = nextOsloTime(a.openSince, cfg.evening);
      if (ev) next.push(Math.max(ev, a.openSince + cfg.openMs));
    }
  }
  const nextAt = next.length ? Math.max(Math.min(...next), now + 1000) : null;
  return { alert: a, messages, nextAt };
}

const DOOR_TEXT = {
  open: "står åpen",
  moving: "er ikke helt lukket",
  opening: "er ikke helt lukket",
  closing: "er ikke helt lukket",
  error: "melder sensorfeil (ikke lukket?)",
};
const STATUS_TEXT = {
  closed: "Lukket", open: "Åpen", moving: "Halvåpen / stoppet", opening: "Åpner", closing: "Lukker",
  error: "Sensorfeil", unknown: "Ukjent",
};

// Lager ntfy-meldingen (JSON-publisering) for ett varsel.
export function ntfyMessage(msg, cfg, now) {
  const since = msg.openSince ? `Åpen siden kl. ${osloClock(msg.openSince)} (${Math.round((now - msg.openSince) / 60_000)} min).` : "";
  const door = DOOR_TEXT[msg.status] ?? "står åpen";
  let title, message, priority = 4, tags = ["warning"], snooze = false;
  switch (msg.kind) {
    case "open":
      title = `Garasjeporten ${door}`;
      message = `${since} Trykk «Jeg er i garasjen» for å slippe flere varsler til den er lukket.`;
      snooze = true;
      break;
    case "reminder":
      title = `Garasjeporten ${door} fortsatt`;
      message = `${since} Siste påminnelse` + (msg.eveningTime ? `, bortsett fra én sjekk kl. ${osloClock(msg.eveningTime)}.` : ".");
      snooze = true;
      break;
    case "evening":
      title = `Garasjeporten ${door} i kveld`;
      message = `${since} Ingen flere varsler før den er lukket.`;
      priority = 5;
      break;
    case "closed":
      title = "Garasjeporten er lukket";
      message = `Den var åpen fra kl. ${osloClock(msg.openSince)}.`;
      priority = 2;
      tags = ["white_check_mark"];
      break;
    case "stale":
      title = "Ingen kontakt med garasjeporten";
      message = `Siste melding fra noden kom kl. ${osloClock(msg.lastPacketAt)}.`
        + (msg.lastStatus ? ` Siste kjente status: ${STATUS_TEXT[msg.lastStatus] ?? msg.lastStatus}.` : "");
      tags = ["satellite"];
      break;
    case "contact":
      title = "Kontakt med garasjeporten igjen";
      message = `Status: ${STATUS_TEXT[msg.status] ?? msg.status}.`;
      priority = 2;
      tags = ["white_check_mark"];
      break;
    default:
      return null;
  }
  const body = { topic: cfg.topic, title, message, priority, tags };
  if (cfg.appUrl) body.click = cfg.appUrl;
  const actions = [];
  if (snooze && cfg.workerUrl && cfg.actionKey) {
    actions.push({
      action: "http",
      label: "Jeg er i garasjen",
      url: `${cfg.workerUrl}/alert/snooze`,
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.actionKey}` },
      clear: true,
    });
  }
  if (cfg.appUrl && msg.kind !== "closed" && msg.kind !== "contact") {
    actions.push({ action: "view", label: "Åpne appen", url: cfg.appUrl });
  }
  if (actions.length) body.actions = actions;
  return body;
}
