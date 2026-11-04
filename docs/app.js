(() => {
  const WORKER = window.GARAGE_CONFIG.workerUrl.replace(/\/+$/, "");
  const TOKEN_KEY = "garasjeport.token";
  const POLL_MS = 5000;
  const FAST_POLL_MS = 2000; // while a command is pending or the door is moving
  const NO_REACTION_MS = 12_000; // the node normally reacts within ~2.5 s
  const REQUEST_TIMEOUT_MS = 10_000; // no request may hang the app

  const LABELS = {
    closed: "Lukket",
    open: "Åpen",
    moving: "I bevegelse / stoppet",
    opening: "Åpner",
    closing: "Lukker",
    error: "Feil (sensor)",
    unknown: "Ukjent",
  };
  const ACTION_LABELS = { open: "Åpne", close: "Lukk", pulse: "Manuell puls" };
  // Shown (pale) between sending a command and the node's first reaction.
  const PENDING = { open: ["opening", "Åpner"], close: ["closing", "Lukker"], pulse: ["moving", "Puls sendt"] };
  const LIVE_OK_MS = 15 * 60_000; // the node reports every ~10 min
  const LIVE_WARN_MS = 30 * 60_000;

  const $ = (id) => document.getElementById(id);
  let clockOffset = 0;
  let last = null;
  let busy = false;
  let offline = false;
  let lastPacketAt = null;

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  }
  let memToken = getToken();
  function setToken(value) {
    try {
      if (value) localStorage.setItem(TOKEN_KEY, value);
      else localStorage.removeItem(TOKEN_KEY);
    } catch { /* private mode: token lives only for this page load */ }
    memToken = value;
  }

  class AuthError extends Error {}

  async function api(path, options = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(WORKER + path, {
        ...options,
        signal: ctrl.signal,
        headers: {
          Authorization: `Bearer ${memToken}`,
          "Content-Type": "application/json",
        },
      });
    } catch (err) {
      throw new Error(ctrl.signal.aborted ? "Workeren svarte ikke i tide." : "Får ikke kontakt med Workeren.");
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401) throw new AuthError();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Feil fra Workeren (HTTP ${res.status}).`);
    return data;
  }

  const serverNow = () => Date.now() + clockOffset;

  function clock(iso) {
    const d = new Date(iso);
    const sameDay = new Date(serverNow()).toDateString() === d.toDateString();
    const time = d.toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit" });
    return sameDay ? time : `${d.toLocaleDateString("nb-NO", { day: "numeric", month: "short" })} ${time}`;
  }

  function ago(iso) {
    const s = Math.max(0, Math.round((serverNow() - Date.parse(iso)) / 1000));
    if (s < 60) return "nå nettopp";
    if (s < 3600) return `for ${Math.floor(s / 60)} min siden`;
    if (s < 86400) return `for ${Math.floor(s / 3600)} t siden`;
    return `for ${Math.floor(s / 86400)} d siden`;
  }

  function showMessage(text) {
    $("message").textContent = text || "";
    $("message").hidden = !text;
  }

  function showLogin(error) {
    $("app").hidden = true;
    $("login").hidden = false;
    $("login-error").textContent = error || "";
    $("login-error").hidden = !error;
    $("token-input").focus();
  }

  function render(s) {
    last = s;
    $("login").hidden = true;
    $("app").hidden = false;

    const pending = s.pendingCommand;
    const [cls, label] = pending ? PENDING[pending.action] : [s.status, LABELS[s.status] || s.status];
    const tentative = !!pending || s.statusConfirmed === false;
    $("status-card").className = `card status-${cls}${tentative ? " tentative" : ""}`;
    $("status-label").textContent = label;
    $("status-card").title = tentative ? "Foreløpig, venter på bekreftelse fra porten" : "";

    // Any packet from the node (status or trigger) shows that the system is alive.
    const packetAt = [s.updatedAt, s.lastTriggerAt].filter(Boolean).sort().pop() ?? null;
    if (lastPacketAt && packetAt && packetAt > lastPacketAt) blinkDot();
    lastPacketAt = packetAt;
    renderDot();
    $("last-seen").textContent = packetAt ? `${clock(packetAt)} (${ago(packetAt)})` : "–";

    // What TTN said about the latest downlink, if it came after the command.
    const cmd = pending || s.unansweredCommand;
    const dl = cmd && s.lastDownlink && Date.parse(s.lastDownlink.at) >= Date.parse(cmd.sentAt) ? s.lastDownlink : null;
    const ttnSaid = !dl ? ""
      : dl.event === "failed" ? ` TTN meldte at sendingen feilet (${dl.error}).`
        : dl.event === "sent" ? " TTN sendte kommandoen, men noden har ikke reagert."
          : "";

    let notice = "";
    if (pending) {
      if (serverNow() - Date.parse(pending.sentAt) > NO_REACTION_MS || dl?.event === "failed") {
        notice = "Ingen reaksjon fra porten ennå." + ttnSaid;
      }
    } else if (s.unansweredCommand) {
      notice = `Porten reagerte ikke på «${ACTION_LABELS[s.unansweredCommand.action]}» (kl. ${clock(s.unansweredCommand.sentAt)}).${ttnSaid} Prøv igjen.`;
    } else if (s.statusConfirmed !== false && s.lastTriggerAt && (!s.updatedAt || s.lastTriggerAt > s.updatedAt)
      && serverNow() - Date.parse(s.lastTriggerAt) < 60_000) {
      notice = "Endring oppdaget, venter på status …";
    } else if (s.status === "moving") {
      notice = "Porten er verken helt åpen eller helt lukket. Den kan være i bevegelse eller stoppet midtveis.";
    } else if (s.status === "error") {
      notice = "Begge sensorene melder magnet inntil. Sjekk reed-bryterne.";
    } else if (s.status === "unknown") {
      notice = "Ingen fersk statusmelding fra noden. Statusen kan være feil.";
    }
    if (s.pulsesToday >= s.pulseLimit) {
      notice = [notice, `Dagens grense på ${s.pulseLimit} relépulser er nådd. Kommandoer er sperret til midnatt.`]
        .filter(Boolean).join("\n\n");
    }
    $("notice").textContent = notice;
    $("notice").hidden = !notice;

    // One button: Åpne when closed, Lukk when open, otherwise a manual pulse with a warning.
    const btn = $("action-btn");
    btn.dataset.action = s.status === "closed" ? "open" : s.status === "open" ? "close" : "pulse";
    // During a normal run the pulse button is grey and neutral; red only when the door
    // has stopped midway, the sensors disagree or the status is unknown.
    const running = s.status === "opening" || s.status === "closing";
    const waiting = !!pending || busy;
    btn.textContent = waiting ? "Venter på porten …"
      : btn.dataset.action !== "pulse" ? ACTION_LABELS[btn.dataset.action]
        : running ? "Send puls (stopp/snu) …" : "Send manuell puls …";
    btn.className = `big ${waiting || btn.dataset.action !== "pulse" ? "primary" : running ? "neutral" : "danger"}`;
    btn.disabled = busy || !!pending || s.pulsesToday >= s.pulseLimit;

    const lvl = (v) => (v === "L" ? "magnet inntil" : v === "H" ? "magnet borte" : "–");
    const closedV = s.closedSensor === "DI1" ? s.di1 : s.di2;
    const openV = s.openSensor === "DI1" ? s.di1 : s.di2;
    $("sensors").textContent = s.updatedAt
      ? `${s.closedSensor} (lukket-bryter): ${lvl(closedV)}\n${s.openSensor} (åpen-bryter): ${lvl(openV)}`
      : "–";
    $("signal").textContent = s.rssi != null ? `RSSI ${s.rssi} dBm · SNR ${s.snr} dB` : "–";
    $("budget").textContent = `${s.pulsesToday} av ${s.pulseLimit}`
      + (s.pulsesToday >= s.pulseLimit ? " (oppbrukt)" : "");
    $("downlinks").textContent = String(s.downlinksToday);
  }

  function renderHistory(items) {
    const list = $("history");
    list.replaceChildren();
    items = items.filter((h) => h.type !== "trigger" && h.type !== "downlink");
    if (!items.length) {
      const li = document.createElement("li");
      li.textContent = "Ingen hendelser ennå.";
      li.className = "muted";
      list.append(li);
      return;
    }
    for (const h of items.slice(0, 30)) {
      const li = document.createElement("li");
      const time = document.createElement("time");
      time.dateTime = h.t;
      time.textContent = clock(h.t);
      const text = document.createElement("span");
      text.textContent = h.type === "command"
        ? `Kommando: ${ACTION_LABELS[h.action] || h.action} (status før: ${LABELS[h.statusBefore] || h.statusBefore})`
        : `Status: ${LABELS[h.status] || h.status}`;
      li.append(time, text);
      list.append(li);
    }
  }

  function renderDot() {
    const age = lastPacketAt ? serverNow() - Date.parse(lastPacketAt) : Infinity;
    const level = offline || age > LIVE_WARN_MS ? "bad" : age > LIVE_OK_MS ? "warn" : "ok";
    const dot = $("live-dot");
    dot.classList.remove("dot-ok", "dot-warn", "dot-bad");
    dot.classList.add(`dot-${level}`);
    dot.setAttribute("aria-label", offline ? "Ingen kontakt med Workeren"
      : lastPacketAt ? `Siste melding fra porten ${ago(lastPacketAt)}` : "Ingen melding fra porten");
  }

  function blinkDot() {
    const dot = $("live-dot");
    dot.classList.remove("blink");
    void dot.offsetWidth; // restart the animation
    dot.classList.add("blink");
  }

  let timeTimer;
  function showTime() {
    const el = $("status-time");
    el.textContent = offline ? "Ingen kontakt med Workeren"
      : lastPacketAt ? `Siste melding ${clock(lastPacketAt)} (${ago(lastPacketAt)})` : "Ingen melding fra porten ennå";
    el.hidden = false;
    clearTimeout(timeTimer);
    timeTimer = setTimeout(() => { el.hidden = true; }, 4000);
  }

  async function refresh() {
    if (!memToken) return showLogin();
    try {
      const s = await api("/api/status");
      clockOffset = Date.parse(s.serverTime) - Date.now();
      if (last?.updatedAt !== s.updatedAt || last?.status !== s.status
        || !!last?.pendingCommand !== !!s.pendingCommand) loadHistory();
      offline = false;
      render(s);
      if ($("message").dataset.network) { showMessage(""); delete $("message").dataset.network; }
    } catch (err) {
      if (err instanceof AuthError) return showLogin("Tokenet ble avvist. Prøv igjen.");
      showMessage("Får ikke kontakt med Workeren. Prøver igjen …");
      $("message").dataset.network = "1";
      offline = true;
      renderDot();
    }
  }

  async function loadHistory() {
    try {
      renderHistory((await api("/api/history")).history);
    } catch { /* status refresh reports connectivity problems */ }
  }

  async function sendCommand(action) {
    const s = last;
    if (!s) return;
    if (!(await askConfirm(action, s))) return;

    busy = true;
    render(s);
    showMessage("");
    try {
      await api("/api/command", { method: "POST", body: JSON.stringify({ action }) });
    } catch (err) {
      if (err instanceof AuthError) return showLogin("Tokenet ble avvist. Prøv igjen.");
      showMessage(err.message);
    } finally {
      busy = false;
    }
    await refresh();
  }

  // Confirmation sheet with the safety warning. Resolves true only for the action button.
  function askConfirm(action, s) {
    const dlg = $("confirm");
    const text = {
      open: ["Åpne porten?", "Åpne porten"],
      close: ["Lukke porten?", "Lukk porten"],
      pulse: ["Sende manuell puls?", "Send puls"],
    }[action];
    $("confirm-title").textContent = text[0];
    $("confirm-ok").textContent = text[1];
    $("confirm-ok").className = `big ${action === "pulse" ? "danger-fill" : "primary"}`;
    $("confirm-extra").textContent = action === "pulse"
      ? `Status er «${LABELS[s.status] || s.status}». Pulsen kan åpne, lukke eller stoppe porten, avhengig av hvor den er i sekvensen.`
      : "";
    $("confirm-extra").hidden = action !== "pulse";
    dlg.returnValue = "";
    return new Promise((resolve) => {
      dlg.addEventListener("close", () => resolve(dlg.returnValue === "ok"), { once: true });
      dlg.showModal();
      $("confirm-ok").focus();
    });
  }
  // Tapping the dimmed background cancels.
  $("confirm").addEventListener("click", (e) => {
    if (e.target === $("confirm")) $("confirm").close("cancel");
  });
  $("live-dot").addEventListener("click", showTime);

  $("login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    setToken($("token-input").value.trim());
    $("token-input").value = "";
    refresh();
  });
  $("settings-btn").addEventListener("click", () => {
    if (confirm("Vil du fjerne tilgangstokenet fra denne nettleseren?")) {
      setToken(null);
      last = null;
      showLogin();
    }
  });
  $("action-btn").addEventListener("click", () => sendCommand($("action-btn").dataset.action));

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });

  // Poll faster while something is happening, so each step shows up within ~2 s.
  const active = (s) => !!s && (!!s.pendingCommand || s.statusConfirmed === false
    || ["opening", "closing", "moving"].includes(s.status));
  async function poll() {
    try {
      if (document.visibilityState === "visible" && memToken && !busy) await refresh();
    } finally {
      setTimeout(poll, active(last) ? FAST_POLL_MS : POLL_MS);
    }
  }

  refresh();
  setTimeout(poll, POLL_MS);
  setInterval(() => { if (last) renderDot(); }, 30_000);
})();
