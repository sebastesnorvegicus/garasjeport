import { test } from "node:test";
import assert from "node:assert/strict";
import { nextOsloTime, ntfyMessage, planAlerts, readAlertConfig } from "../src/logic.js";

const cfg = readAlertConfig({
  NTFY_TOPIC: "garasje-test",
  ALERT_ACTION_KEY: "key",
  WORKER_URL: "https://w.example/",
  APP_URL: "https://app.example/",
});
const MIN = 60_000;
// 7. nov 2026 12:00 i Oslo (vintertid, UTC+1)
const t0 = Date.parse("2026-11-07T11:00:00Z");

// Kjører planAlerts minutt for minutt og samler varslene.
function simulate({ from = t0, minutes, statusAt = () => "open", packetEvery = 10, snoozeAt = null }) {
  let alert = null;
  const sent = [];
  let lastPacketAt = from;
  for (let m = 0; m <= minutes; m++) {
    const now = from + m * MIN;
    if (packetEvery && m % packetEvery === 0) lastPacketAt = now;
    if (snoozeAt === m) alert = { ...alert, snoozedAt: now };
    const r = planAlerts({ alert, status: statusAt(m), lastPacketAt, now, cfg });
    alert = r.alert;
    for (const msg of r.messages) sent.push([m, msg.kind]);
  }
  return sent;
}

test("nextOsloTime finner neste 22:00 i norsk tid, også over sommertid", () => {
  assert.equal(new Date(nextOsloTime(t0, [22, 0])).toISOString(), "2026-11-07T21:00:00.000Z");
  // etter 22:00 blir det neste dag
  assert.equal(new Date(nextOsloTime(Date.parse("2026-11-07T21:30:00Z"), [22, 0])).toISOString(), "2026-11-08T21:00:00.000Z");
  assert.equal(new Date(nextOsloTime(Date.parse("2026-07-01T10:00:00Z"), [22, 0])).toISOString(), "2026-07-01T20:00:00.000Z");
});

test("åpen port: varsel etter 15 min, én påminnelse, så kveldsvarsel kl. 22 og ingenting mer", () => {
  const sent = simulate({ minutes: 14 * 60 });
  assert.deepEqual(sent, [[15, "open"], [75, "reminder"], [600, "evening"]]);
});

test("«Jeg er i garasjen» stopper varslene, men kveldsvarselet kommer likevel", () => {
  const sent = simulate({ minutes: 14 * 60, snoozeAt: 20 });
  assert.deepEqual(sent, [[15, "open"], [600, "evening"]]);
});

test("pause før første varsel gir ingen varsler før kveld", () => {
  const sent = simulate({ minutes: 9 * 60, snoozeAt: 5 });
  assert.deepEqual(sent, []);
});

test("lukket etter varsel gir «lukket»-melding, og ny åpning starter på nytt", () => {
  const sent = simulate({ minutes: 60, statusAt: (m) => (m < 20 ? "open" : m < 30 ? "closed" : "open") });
  assert.deepEqual(sent, [[15, "open"], [20, "closed"], [45, "open"]]);
});

test("kort åpning gir ingen varsler i det hele tatt", () => {
  const sent = simulate({ minutes: 60, statusAt: (m) => (m < 10 ? "open" : "closed") });
  assert.deepEqual(sent, []);
});

test("halvåpen eller sensorfeil teller som ikke lukket", () => {
  assert.deepEqual(simulate({ minutes: 20, statusAt: () => "moving" }), [[15, "open"]]);
  assert.deepEqual(simulate({ minutes: 20, statusAt: () => "error" }), [[15, "open"]]);
});

test("åpnet like før 22: ett kveldsvarsel i stedet for vanlig varsel", () => {
  const from = Date.parse("2026-11-07T20:55:00Z"); // 21:55
  const sent = simulate({ from, minutes: 120 });
  assert.deepEqual(sent, [[15, "evening"]]);
});

test("stille node: ett varsel etter 60 min, og beskjed når kontakten er tilbake", () => {
  let alert = null;
  const at = (m) => t0 + m * MIN;
  const step = (m, status, last) => {
    const r = planAlerts({ alert, status, lastPacketAt: at(last), now: at(m), cfg });
    alert = r.alert;
    return r;
  };
  step(0, "closed", 0);
  assert.equal(step(59, "unknown", 0).messages.length, 0);
  const r1 = step(60, "unknown", 0);
  assert.deepEqual(r1.messages.map((x) => x.kind), ["stale"]);
  assert.equal(r1.messages[0].lastStatus, "closed");
  assert.equal(step(120, "unknown", 0).messages.length, 0);
  assert.deepEqual(step(130, "closed", 130).messages.map((x) => x.kind), ["contact"]);
});

test("neste alarm settes til første tidspunkt noe kan skje", () => {
  const r = planAlerts({ alert: null, status: "open", lastPacketAt: t0, now: t0, cfg });
  assert.equal(r.nextAt, t0 + 15 * MIN);
  const c = planAlerts({ alert: null, status: "closed", lastPacketAt: t0, now: t0, cfg });
  assert.equal(c.nextAt, t0 + 60 * MIN); // bare stillhets-sjekken
});

test("ntfy-melding har pauseknapp med egen nøkkel og lenke til appen", () => {
  const body = ntfyMessage({ kind: "open", status: "open", openSince: t0 }, cfg, t0 + 15 * MIN);
  assert.equal(body.topic, "garasje-test");
  assert.equal(body.title, "Garasjeporten står åpen");
  assert.match(body.message, /Åpen siden kl\. 12:00 \(15 min\)/);
  assert.equal(body.click, "https://app.example/");
  assert.deepEqual(body.actions[0], {
    action: "http", label: "Jeg er i garasjen", url: "https://w.example/alert/snooze",
    method: "POST", headers: { Authorization: "Bearer key" }, clear: true,
  });
  assert.equal(ntfyMessage({ kind: "evening", status: "open", openSince: t0 }, cfg, t0).actions.length, 1);
  assert.equal(ntfyMessage({ kind: "closed", openSince: t0 }, cfg, t0).actions, undefined);
});

test("varsler er av uten NTFY_TOPIC", () => {
  assert.equal(readAlertConfig({}).enabled, false);
});
