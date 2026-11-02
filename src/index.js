import { parseUplink, safeEqual } from "./logic.js";

export { GarageState } from "./garage.js";

// The Worker checks secrets, tokens and CORS. All state and the command logic
// live in the GarageState Durable Object.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/ttn/uplink" && request.method === "POST") {
        return await handleUplink(request, env);
      }
      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, env, url.pathname);
      }
      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error(err);
      return json({ error: "Intern feil i Workeren." }, 500, corsHeaders(request, env));
    }
  },
};

function garage(env, op, args = {}) {
  const stub = env.GARAGE_DO.get(env.GARAGE_DO.idFromName("garage"));
  return stub.fetch("https://garage/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op, ...args }),
  });
}

async function handleUplink(request, env) {
  if (!(await safeEqual(request.headers.get("X-Webhook-Secret"), env.WEBHOOK_SECRET))) {
    return new Response("Unauthorized", { status: 401 });
  }
  const body = await request.json().catch(() => null);
  const up = parseUplink(body, env.TTN_DEVICE_ID);
  if (up.kind === "ignore") return new Response("ignored");

  const res = await garage(env, "uplink", { up });
  const { result } = await res.json();
  return new Response(result ?? "ok", { status: res.status });
}

async function handleApi(request, env, path) {
  const cors = corsHeaders(request, env);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!(await safeEqual(token, env.APP_TOKEN))) {
    return json({ error: "Feil eller manglende tilgangstoken." }, 401, cors);
  }

  let res;
  if (path === "/api/status" && request.method === "GET") res = await garage(env, "status");
  else if (path === "/api/history" && request.method === "GET") res = await garage(env, "history");
  else if (path === "/api/command" && request.method === "POST") {
    const body = await request.json().catch(() => null);
    res = await garage(env, "command", { action: body?.action });
  } else {
    return json({ error: "Ukjent API-sti." }, 404, cors);
  }
  return json(await res.json(), res.status, cors);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = (env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
  const headers = { Vary: "Origin" };
  if (origin && allowed.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type";
    headers["Access-Control-Max-Age"] = "86400";
  }
  return headers;
}

function json(data, status, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders },
  });
}
