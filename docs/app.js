(() => {
  const WORKER = window.GARAGE_CONFIG.workerUrl.replace(/\/+$/, "");
  const TOKEN_KEY = "garasjeport.token";
  const POLL_MS = 5000;
  const FAST_POLL_MS = 2000; // while a command is pending or the door is moving
  const NO_REACTION_MS = 12_000; // the node normally reacts within ~2.5 s

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
  const PENDING_LABELS = { open: "Åpner …", close: "Lukker …", pulse: "Puls sendt …" };

  const $ = (id) => document.getElementById(id);
  let clockOffset = 0;
  let last = null;
  let busy = false;

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
    const res = await fetch(WORKER + path, {
      ...options,
      headers: {
        Authorization: `Bearer ${memToken}`,
        "Content-Type": "application/json",
      },
    });
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
    $("status-card").className = `card status-${pending ? "moving" : s.status}`;
    $("status-label").textContent = pending ? PENDING_LABELS[pending.action] : (LABELS[s.status] || s.status);
    $("status-time").textContent = pending
      ? `Kommando sendt kl. ${clock(pending.sentAt)}, venter på at porten reagerer`
      : s.statusConfirmed === false
        ? "Foreløpig, bekreftes av neste statusmelding om noen sekunder"
        : s.updatedAt
          ? `Siste statusmelding ${ago(s.updatedAt)} (${clock(s.updatedAt)})`
          : "Ingen statusmelding mottatt ennå";

    let notice = "";
    if (pending) {
      if (serverNow() - Date.parse(pending.sentAt) > NO_REACTION_MS) {
        notice = "Ingen reaksjon fra porten ennå. Statusen oppdateres når noden melder fra.";
      }
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
    btn.textContent = pending || busy ? "Venter på porten …"
      : btn.dataset.action === "pulse" ? "Send manuell puls …" : ACTION_LABELS[btn.dataset.action];
    btn.className = `big ${btn.dataset.action === "pulse" && !pending && !busy ? "danger" : "primary"}`;
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
    items = items.filter((h) => h.type !== "trigger");
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

  async function refresh() {
    if (!memToken) return showLogin();
    try {
      const s = await api("/api/status");
      clockOffset = Date.parse(s.serverTime) - Date.now();
      if (last?.updatedAt !== s.updatedAt || last?.status !== s.status
        || !!last?.pendingCommand !== !!s.pendingCommand) loadHistory();
      render(s);
      if ($("message").dataset.network) { showMessage(""); delete $("message").dataset.network; }
    } catch (err) {
      if (err instanceof AuthError) return showLogin("Tokenet ble avvist. Prøv igjen.");
      showMessage("Får ikke kontakt med Workeren. Prøver igjen …");
      $("message").dataset.network = "1";
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
    const path = "Sjekk at porten har fri bane (ingen fotocelle er montert).";
    const question = action === "pulse"
      ? `Status er «${LABELS[s.status]}». En manuell puls kan åpne, lukke eller stoppe porten, avhengig av hvor den er i sekvensen.\n\n${path}\n\nSende puls likevel?`
      : `Er du sikker på at du vil ${action === "open" ? "åpne" : "lukke"} porten?\n\n${path}`;
    if (!confirm(question)) return;

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
    if (document.visibilityState === "visible" && memToken && !busy) await refresh();
    setTimeout(poll, active(last) ? FAST_POLL_MS : POLL_MS);
  }

  refresh();
  setTimeout(poll, POLL_MS);
})();
