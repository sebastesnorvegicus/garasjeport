(() => {
  const WORKER = window.GARAGE_CONFIG.workerUrl.replace(/\/+$/, "");
  const TOKEN_KEY = "garasjeport.token";
  const POLL_MS = 5000;

  const LABELS = {
    closed: "Lukket",
    open: "Åpen",
    moving: "I bevegelse / stoppet",
    error: "Feil (sensor)",
    unknown: "Ukjent",
  };
  const ACTION_LABELS = { open: "Åpne", close: "Lukk", pulse: "Manuell puls" };

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

    $("status-card").className = `card status-${s.status}`;
    $("status-label").textContent = LABELS[s.status] || s.status;
    $("status-time").textContent = s.updatedAt
      ? `Siste statusmelding ${ago(s.updatedAt)} (${clock(s.updatedAt)})`
      : "Ingen statusmelding mottatt ennå";

    let notice = "";
    if (s.pendingCommand) {
      notice = `${ACTION_LABELS[s.pendingCommand.action]}: kommando sendt kl. ${clock(s.pendingCommand.sentAt)}, venter på status …`;
    } else if (s.lastTriggerAt && (!s.updatedAt || s.lastTriggerAt > s.updatedAt)
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

    const blocked = busy || !!s.pendingCommand || s.pulsesToday >= s.pulseLimit;
    $("open-btn").disabled = blocked || s.status !== "closed";
    $("close-btn").disabled = blocked || s.status !== "open";
    $("pulse-btn").hidden = !["moving", "error", "unknown"].includes(s.status);
    $("pulse-btn").disabled = blocked;

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
      if (last?.updatedAt !== s.updatedAt || !!last?.pendingCommand !== !!s.pendingCommand) loadHistory();
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
  $("open-btn").addEventListener("click", () => sendCommand("open"));
  $("close-btn").addEventListener("click", () => sendCommand("close"));
  $("pulse-btn").addEventListener("click", () => sendCommand("pulse"));

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });
  setInterval(() => {
    if (document.visibilityState === "visible" && memToken && !busy) refresh();
  }, POLL_MS);

  refresh();
})();
