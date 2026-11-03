import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkCommand,
  computeStatus,
  effectiveStatus,
  inferFromTrigger,
  osloDate,
  parseUplink,
  pendingCommand,
  readConfig,
  safeEqual,
  triggerSensor,
} from "../src/logic.js";

const cfg = readConfig({});
const now = Date.parse("2026-10-22T12:00:00Z");
const fresh = (di1, di2) => ({ di1, di2, statusAt: "2026-10-22T11:55:00Z" });

test("status table with default sensors (DI1 = closed switch)", () => {
  assert.equal(computeStatus(fresh("L", "H"), cfg, now), "closed");
  assert.equal(computeStatus(fresh("H", "L"), cfg, now), "open");
  assert.equal(computeStatus(fresh("H", "H"), cfg, now), "moving");
  assert.equal(computeStatus(fresh("L", "L"), cfg, now), "error");
});

test("swapped sensors via CLOSED_SENSOR=DI2", () => {
  const swapped = readConfig({ CLOSED_SENSOR: "DI2" });
  assert.equal(computeStatus(fresh("L", "H"), swapped, now), "open");
  assert.equal(computeStatus(fresh("H", "L"), swapped, now), "closed");
});

test("unknown when no state or older than 30 minutes", () => {
  assert.equal(computeStatus(null, cfg, now), "unknown");
  assert.equal(computeStatus({ di1: "L", di2: "H", statusAt: "2026-10-22T11:29:00Z" }, cfg, now), "unknown");
  assert.equal(computeStatus({ di1: "L", di2: "H", statusAt: "2026-10-22T11:31:00Z" }, cfg, now), "closed");
});

const uplink = (payload, extra = {}) => ({
  end_device_ids: { device_id: "garasjeport-node" },
  uplink_message: {
    f_port: 2,
    f_cnt: 42,
    received_at: "2026-10-22T11:59:00Z",
    decoded_payload: payload,
    rx_metadata: [{ rssi: -80, snr: 12.5 }],
    ...extra,
  },
});

test("parses MOD1 status packet", () => {
  const up = parseUplink(uplink({ Work_mode: "2ACI+2AVI", DI1_status: "H", DI2_status: "L" }), "garasjeport-node");
  assert.equal(up.kind, "status");
  assert.equal(up.di1, "H");
  assert.equal(up.di2, "L");
  assert.equal(up.rssi, -80);
  assert.equal(up.snr, 12.5);
  assert.equal(up.fCnt, 42);
});

test("MOD6 trigger packet is only an event, never a status", () => {
  const up = parseUplink(
    uplink({ Work_mode: "Exit mode", DI1_flag: "True", DI2_flag: "False", DI1_status: "H", DI2_status: "L" }, { confirmed: true }),
    "garasjeport-node",
  );
  assert.equal(up.kind, "trigger");
  assert.equal(up.confirmed, true);
  assert.equal(up.di1, undefined);
});

test("ignores other devices, ports and malformed bodies", () => {
  assert.equal(parseUplink(uplink({ Work_mode: "2ACI+2AVI", DI1_status: "H", DI2_status: "L" }), "other").kind, "ignore");
  assert.equal(parseUplink(uplink({ Work_mode: "2ACI+2AVI", DI1_status: "H", DI2_status: "L" }, { f_port: 3 }), "garasjeport-node").kind, "ignore");
  assert.equal(parseUplink(uplink({ Work_mode: "2ACI+2AVI", DI1_status: "x", DI2_status: "L" }), "garasjeport-node").kind, "ignore");
  assert.equal(parseUplink(null, "garasjeport-node").kind, "ignore");
});

test("command rules", () => {
  const ctx = { now, lastSentAt: null, pulsesToday: 0 };
  assert.equal(checkCommand("open", "closed", ctx, cfg).ok, true);
  assert.equal(checkCommand("open", "open", ctx, cfg).code, "wrong_state");
  assert.equal(checkCommand("open", "moving", ctx, cfg).code, "wrong_state");
  assert.equal(checkCommand("close", "open", ctx, cfg).ok, true);
  assert.equal(checkCommand("close", "unknown", ctx, cfg).code, "wrong_state");
  assert.equal(checkCommand("pulse", "error", ctx, cfg).ok, true);
  assert.equal(checkCommand("explode", "closed", ctx, cfg).code, "bad_action");
});

test("rate limit and daily pulse limit", () => {
  const recent = { now, lastSentAt: new Date(now - 10_000).toISOString(), pulsesToday: 0 };
  assert.equal(checkCommand("pulse", "open", recent, cfg).code, "rate_limited");
  const older = { now, lastSentAt: new Date(now - 16_000).toISOString(), pulsesToday: 0 };
  assert.equal(checkCommand("pulse", "open", older, cfg).ok, true);
  assert.equal(checkCommand("pulse", "open", { now, lastSentAt: null, pulsesToday: 20 }, cfg).code, "budget");
  assert.equal(checkCommand("pulse", "open", { now, lastSentAt: null, pulsesToday: 19 }, cfg).ok, true);
});

test("pending command clears on newer status or after timeout", () => {
  const cmd = { action: "open", sentAt: "2026-10-22T11:59:30Z" };
  assert.deepEqual(pendingCommand(cmd, { statusAt: "2026-10-22T11:59:00Z" }, cfg, now), cmd);
  assert.equal(pendingCommand(cmd, { statusAt: "2026-10-22T11:59:40Z" }, cfg, now), null);
  assert.equal(pendingCommand(cmd, null, cfg, now + 4 * 60_000), null);
});

test("Oslo date rolls over at local midnight", () => {
  assert.equal(osloDate(Date.parse("2026-10-22T21:59:00Z")), "2026-10-22");
  assert.equal(osloDate(Date.parse("2026-10-22T22:01:00Z")), "2026-10-23");
});

test("safeEqual", async () => {
  assert.equal(await safeEqual("abc", "abc"), true);
  assert.equal(await safeEqual("abc", "abd"), false);
  assert.equal(await safeEqual("", ""), false);
  assert.equal(await safeEqual(null, "abc"), false);
  assert.equal(await safeEqual("abc", undefined), false);
});

// Real trigger payloads from 3.11: DIx_status "True" marks the input that fired.
test("triggerSensor reads which input fired", () => {
  assert.equal(triggerSensor({ DI1_status: "False", DI2_status: "True", DI1_flag: "True", DI2_flag: "True" }), "DI2");
  assert.equal(triggerSensor({ DI1_status: "True", DI2_status: "False" }), "DI1");
  assert.equal(triggerSensor({ DI1_status: "True", DI2_status: "True" }), null);
  assert.equal(triggerSensor({ DI1_flag: "True" }), null);
  assert.equal(triggerSensor(undefined), null);
});

test("inferFromTrigger: leaving and reaching end positions (closed sensor DI2)", () => {
  const c = readConfig({ CLOSED_SENSOR: "DI2" });
  assert.equal(inferFromTrigger("DI2", "closed", c), "opening");
  assert.equal(inferFromTrigger("DI1", "opening", c), "open");
  assert.equal(inferFromTrigger("DI1", "open", c), "closing");
  assert.equal(inferFromTrigger("DI2", "closing", c), "closed");
  assert.equal(inferFromTrigger("DI2", "moving", c), "closed");
  assert.equal(inferFromTrigger("DI2", "open", c), null);
  assert.equal(inferFromTrigger("DI1", "closed", c), null);
  assert.equal(inferFromTrigger("DI1", "unknown", c), null);
  assert.equal(inferFromTrigger(null, "closed", c), null);
});

test("effectiveStatus combines status packets and trigger inference", () => {
  const c = readConfig({ CLOSED_SENSOR: "DI2" });
  const t = (sec) => new Date(now + sec * 1000).toISOString();
  const closed = { di1: "H", di2: "L", statusAt: t(-60) };
  const moving = { di1: "H", di2: "H", statusAt: t(-20) };

  // no trigger: status packet as is
  assert.deepEqual(effectiveStatus(closed, null, null, c, now), { status: "closed", confirmed: true });
  // trigger newer than the status packet: unconfirmed
  assert.deepEqual(effectiveStatus(closed, { status: "opening", at: t(-25) }, null, c, now), { status: "opening", confirmed: false });
  assert.deepEqual(effectiveStatus(moving, { status: "open", at: t(-2) }, null, c, now), { status: "open", confirmed: false });
  // "moving" status packet gets the direction from the trigger before it
  assert.deepEqual(effectiveStatus(moving, { status: "opening", at: t(-27) }, null, c, now), { status: "opening", confirmed: true });
  // direction expires after motionMaxMs, and is dropped after a new pulse
  assert.equal(effectiveStatus(moving, { status: "opening", at: t(-70) }, null, c, now).status, "moving");
  assert.equal(effectiveStatus(moving, { status: "opening", at: t(-27) }, { sentAt: t(-10) }, c, now).status, "moving");
  assert.equal(effectiveStatus({ ...closed, statusAt: t(-90) }, { status: "opening", at: t(-80) }, null, c, now).status, "moving");
  // a newer end-position status packet always wins
  const open = { di1: "L", di2: "H", statusAt: t(-1) };
  assert.deepEqual(effectiveStatus(open, { status: "open", at: t(-8) }, null, c, now), { status: "open", confirmed: true });
  assert.deepEqual(effectiveStatus(open, { status: "closed", at: t(-8) }, null, c, now), { status: "open", confirmed: true });
});

test("pending command clears on a newer trigger", () => {
  const cmd = { action: "open", sentAt: "2026-10-22T11:59:30Z" };
  assert.deepEqual(pendingCommand(cmd, null, cfg, now, "2026-10-22T11:59:00Z"), cmd);
  assert.equal(pendingCommand(cmd, null, cfg, now, "2026-10-22T11:59:32Z"), null);
});
