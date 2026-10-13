#!/usr/bin/env node
/**
 * OpenCode V1 <-> V2 translation bridge
 * ------------------------------------
 * OC Remote (and other V1-era clients) speak the OpenCode V1 HTTP API:
 *   GET /global/health, /global/event, /session, /config, /app, ...
 *
 * OpenCode V2 moved everything under /api/ and dropped /global/health:
 *   GET /api/info, /api/event, /api/session, /api/config, /api/provider, /api/model
 *
 * This proxy listens on PORT (default 4097) and forwards V1-style requests to a
 * V2 upstream (default http://127.0.0.1:4096), rewriting paths AND adapting the
 * responses whose shape changed.
 *
 * Shape adaptation has two halves:
 *   1. Synthetic routes V2 has no equivalent for (/global/health, /global/version,
 *      /path, /session/status) are built locally.
 *   2. V2 envelopes are unwrapped/re-wrapped for the V1 routes the app reads:
 *      /session, /session/{id}, /session/{id}/message, /provider, /config/providers,
 *      /agent, /command, /config, /global/config.
 *
 * Everything else is streamed back verbatim (SSE, message streams, ...).
 *
 * Usage:
 *   node v1v2-bridge.mjs
 *   PORT=4097 UPSTREAM=http://127.0.0.1:4096 \
 *   UPSTREAM_USERNAME=opencode UPSTREAM_PASSWORD=secret \
 *   BRIDGE_USERNAME=opencode BRIDGE_PASSWORD=secret \
 *   node v1v2-bridge.mjs
 */

import http from "node:http";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";

const PORT = Number(process.env.PORT || 4097);
const HOST = process.env.HOST || "0.0.0.0";
const UPSTREAM = (process.env.UPSTREAM || "http://127.0.0.1:4096").replace(/\/+$/, "");

// Auth used when talking to the V2 upstream server.
const UPSTREAM_USERNAME = process.env.UPSTREAM_USERNAME || "";
const UPSTREAM_PASSWORD = process.env.UPSTREAM_PASSWORD || "";

// Auth the bridge itself requires from clients (optional).
const BRIDGE_USERNAME = process.env.BRIDGE_USERNAME || "";
const BRIDGE_PASSWORD = process.env.BRIDGE_PASSWORD || "";

const VERBOSE = process.env.VERBOSE === "1";

function basic(user, pass) {
  if (!user && !pass) return null;
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

const UPSTREAM_AUTH = basic(UPSTREAM_USERNAME, UPSTREAM_PASSWORD);

function log(...args) {
  if (VERBOSE) console.log(new Date().toISOString(), ...args);
}

/** V1 routes the bridge answers itself (V2 has no counterpart). */
const SYNTHETIC = new Set(["/global/health", "/global/version", "/path", "/session/status"]);

/**
 * Map a V1 request path to its V2 equivalent.
 *
 * V2 namespaces almost everything under /api/. A few V1 routes have no direct
 * V2 counterpart and are handled separately (see handleSynthetic).
 */
function mapPath(pathname) {
  // Already V2-shaped - pass straight through.
  if (pathname.startsWith("/api/")) return pathname;

  // V1-only routes we synthesize locally.
  if (SYNTHETIC.has(pathname)) return null;

  // Everything else: prefix with /api/. /global/event -> /api/event,
  // /session -> /api/session, /config -> /api/config, etc.
  let mapped = "/api" + pathname;
  mapped = mapped.replace(/^\/api\/global\//, "/api/");

  // V1 used /config/providers; V2 exposes /api/provider.
  if (mapped === "/api/config/providers") mapped = "/api/provider";

  return mapped;
}

/**
 * V1 sends a prompt as `POST /session/:id/message` with
 * `{ parts:[{type:"text",text}], modelID, providerID, agent }`.
 * V2 exposes `POST /api/session/:id/prompt` taking a plain string `text`.
 *
 * Returns `{ path, body }` to rewrite the outgoing request, or null to leave it
 * untouched. Non-prompt POSTs (and every other method) pass straight through.
 */
function rewritePrompt(method, pathname, body) {
  if (method !== "POST") return null;
  const m = pathname.match(/^\/session\/([^/]+)\/(message|chat|prompt)$/);
  if (!m) return null;

  const sessionID = m[1];
  let text = "";
  const extra = {};

  if (body && body.length) {
    let json;
    try {
      json = JSON.parse(body.toString("utf8"));
    } catch {
      json = null;
    }
    if (json && typeof json === "object") {
      if (typeof json.text === "string") {
        text = json.text;
      } else if (Array.isArray(json.parts)) {
        text = json.parts
          .filter((p) => p && p.type === "text" && typeof p.text === "string")
          .map((p) => p.text)
          .join("\n");
      }
      for (const k of ["modelID", "providerID", "agent", "variant"]) {
        if (json[k] !== undefined) extra[k] = json[k];
      }
    }
  }

  return {
    path: `/api/session/${sessionID}/prompt`,
    body: Buffer.from(JSON.stringify({ text, ...extra })),
    sessionID,
  };
}

/** Turn V2's prompt result ({data:{id,payload:{text},...}}) into a V1 Message. */
function promptResultToV1(data, sessionID) {
  if (!data || typeof data !== "object") return data;
  const created = (data.time && data.time.created) || Date.now();
  const text = data.payload && typeof data.payload.text === "string" ? data.payload.text : "";
  const sid = data.sessionID || sessionID;
  return {
    id: data.id,
    sessionID: sid,
    role: "user",
    time: { created },
    parts: text
      ? [
          {
            id: `${data.id}_0`,
            sessionID: sid,
            messageID: data.id,
            type: "text",
            text,
            time: { start: created },
          },
        ]
      : [],
  };
}

/** Read a request body fully. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Authorize an incoming client request against BRIDGE_USERNAME/PASSWORD. */
function clientAuthorized(req) {
  if (!BRIDGE_USERNAME && !BRIDGE_PASSWORD) return true;
  const header = req.headers["authorization"] || "";
  if (!header.startsWith("Basic ")) return false;
  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }
  const idx = decoded.indexOf(":");
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  return user === BRIDGE_USERNAME && pass === BRIDGE_PASSWORD;
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": body.length,
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// V1 shape adaptation
// ---------------------------------------------------------------------------

/** V1 GET routes whose V2 payload is reshaped (keyed by the V1 path). */
const RESHAPE_GET = new Set([
  "/session",
  "/provider",
  "/config/providers",
  "/agent",
  "/command",
  "/config",
  "/global/config",
]);

/** True when this GET needs its payload reshaped rather than streamed. */
function needsReshape(method, pathname) {
  if (method !== "GET") return false;
  if (RESHAPE_GET.has(pathname)) return true;
  if (/^\/session\/[^/]+$/.test(pathname)) return true; // /session/{id}
  if (/^\/session\/[^/]+\/message$/.test(pathname)) return true; // message list
  return false;
}

/** Unwrap a V2 `{ data: ... }` / `{ location, data }` envelope. */
function unwrap(json) {
  if (json && typeof json === "object" && !Array.isArray(json) && "data" in json) {
    return json.data;
  }
  return json;
}

/**
 * Build a V1 ServerConfigResponse out of V2's array of config documents.
 * V1 expects one flat object: { disabled_providers, enabled_providers, model,
 * small_model, default_agent }.
 */
function configFromDocuments(docs) {
  const out = {};
  if (!Array.isArray(docs)) return out;
  for (const doc of docs) {
    const info = doc && doc.info;
    if (!info || typeof info !== "object") continue;
    for (const key of [
      "disabled_providers",
      "enabled_providers",
      "model",
      "small_model",
      "default_agent",
    ]) {
      if (info[key] !== undefined && out[key] === undefined) out[key] = info[key];
    }
  }
  return out;
}

/**
 * V2 splits a message into typed `content` entries that carry their own time and
 * lack the identity fields V1 clients require, so rebuild both.
 */
function partToV1(part, sessionID, messageID, index) {
  if (!part || typeof part !== "object") return part;
  const out = { ...part };

  // V1 requires these on every part; V2 only sets id on tool calls.
  out.id = out.id || `prt_${messageID}_${index}`;
  out.sessionID = sessionID;
  out.messageID = messageID;

  // V2 times are {created, completed|ran|streamed}; V1 wants {start, end?}.
  if (out.time && typeof out.time === "object") {
    const t = out.time;
    const start = t.start ?? t.created;
    const end = t.end ?? t.completed ?? t.ran ?? t.streamed;
    out.time = { start: start ?? Date.now() };
    if (end !== undefined) out.time.end = end;
  }

  switch (out.type) {
    case "reasoning":
      delete out.state;
      if (!out.time) out.time = { start: Date.now() };
      break;
    case "text":
      if (!out.time) out.time = { start: Date.now() };
      break;
    case "tool":
      // V1 Tool part: { callID, tool, state, ... }
      if (out.callID === undefined) out.callID = out.id;
      if (out.tool === undefined) out.tool = out.name;
      delete out.name;
      delete out.executed;
      break;
  }
  return out;
}

/**
 * V1 Message is { id, sessionID, role, time{created,completed?}, parts[] }.
 * V2 uses { type, model, content[] } and omits sessionID (and, for assistant
 * messages, the parentID V1 requires).
 */
function messageToV1(msg, sessionID, previousID) {
  if (!msg || typeof msg !== "object") return msg;
  const out = { ...msg };

  if (out.role === undefined && out.type !== undefined) out.role = out.type;
  delete out.type;
  delete out.rawFinish;

  out.sessionID = sessionID;

  const t = out.time && typeof out.time === "object" ? out.time : {};
  out.time = { created: t.created ?? Date.now() };
  const completed = t.completed ?? t.streamed;
  if (completed !== undefined) out.time.completed = completed;

  // V2 nests the model; V1 wants flat modelID/providerID/variant.
  if (out.model && typeof out.model === "object") {
    if (out.modelID === undefined) out.modelID = out.model.id;
    if (out.providerID === undefined) out.providerID = out.model.providerID;
    if (out.variant === undefined) out.variant = out.model.variant;
    delete out.model;
  }

  // Assistant messages must reference the message they answer.
  if (out.role === "assistant" && !out.parentID) out.parentID = previousID || out.id;

  const content = Array.isArray(out.content)
    ? out.content
    : Array.isArray(out.parts)
      ? out.parts
      : [];
  out.parts = content.map((p, i) => partToV1(p, sessionID, out.id, i));
  delete out.content;

  return out;
}

/**
 * V1 GET /session/:id/message returns MessageWithParts[] - each entry is
 * { info: Message, parts: Part[] }, not a bare Message list.
 */
function messageWithPartsToV1(msg, sessionID, previousID) {
  const info = messageToV1(msg, sessionID, previousID);
  const parts = Array.isArray(info.parts) ? info.parts : [];
  delete info.parts;
  return { info, parts };
}

/** Reshape a V2 payload into the shape the V1 route promised. */
function reshape(v1path, json) {
  const data = unwrap(json);

  switch (v1path) {
    case "/session":
    case "/agent":
    case "/command":
      return Array.isArray(data) ? data : [];
    case "/provider":
      // V1 ProviderCatalogResponse { all, default, connected }
      return { all: Array.isArray(data) ? data : [], default: {}, connected: [] };
    case "/config/providers":
      // V1 ProvidersResponse { providers, default }
      return { providers: Array.isArray(data) ? data : [], default: {} };
    case "/config":
    case "/global/config":
      return configFromDocuments(Array.isArray(json) ? json : data);
  }

  if (/^\/session\/[^/]+$/.test(v1path)) return data;
  if (/^\/session\/[^/]+\/message$/.test(v1path)) {
    const sessionID = v1path.split("/")[2];
    const arr = Array.isArray(data) ? data : [];
    let previousID = null;
    return arr.map((msg) => {
      const v1 = messageWithPartsToV1(msg, sessionID, previousID);
      if (msg && msg.id) previousID = msg.id;
      return v1;
    });
  }

  return undefined;
}

/** V1 ServerPaths - V2 only reports `paths.tmp`, so derive the rest locally. */
function serverPaths() {
  const home = os.homedir();
  const cwd = process.cwd();
  return {
    home,
    state: path.join(home, ".local", "share", "opencode"),
    config: path.join(home, ".config", "opencode"),
    worktree: cwd,
    directory: cwd,
  };
}

async function fetchInfo() {
  const upstream = await fetch(`${UPSTREAM}/api/info`, {
    headers: UPSTREAM_AUTH ? { authorization: UPSTREAM_AUTH } : {},
  });
  if (!upstream.ok) return null;
  return upstream.json().catch(() => null);
}

/**
 * Synthetic V1 routes.
 *
 * /global/health is the one that matters most: OC Remote calls it on connect and
 * treats a non-JSON or non-2xx reply as "server unhealthy". V2 has no equivalent,
 * so we build a V1 ServerHealth from /api/info.
 */
async function handleSynthetic(pathname, res) {
  if (pathname === "/global/health") {
    try {
      const info = await fetchInfo();
      if (!info) return sendJson(res, 200, { healthy: false, version: null });
      return sendJson(res, 200, { healthy: true, version: info.version ?? null });
    } catch (err) {
      log("health probe failed:", err.message);
      // Report unhealthy rather than erroring - clients render this gracefully.
      return sendJson(res, 200, { healthy: false, version: null });
    }
  }

  if (pathname === "/global/version") {
    try {
      const info = await fetchInfo();
      return sendJson(res, 200, { version: info?.version ?? null });
    } catch {
      return sendJson(res, 200, { version: null });
    }
  }

  if (pathname === "/path") {
    return sendJson(res, 200, serverPaths());
  }

  // V1 reports live session statuses as { <sessionID>: SessionStatus }. V2 only
  // exposes per-session status, so report none and let the app derive the rest.
  if (pathname === "/session/status") {
    return sendJson(res, 200, {});
  }

  return sendJson(res, 404, { error: "not found" });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;
  const query = url.search;

  if (!clientAuthorized(req)) {
    res.writeHead(401, { "www-authenticate": 'Basic realm="opencode"' });
    return res.end("Unauthorized");
  }

  let mapped = mapPath(pathname);

  if (mapped === null) {
    log("V1", req.method, pathname, "-> synthetic");
    return handleSynthetic(pathname, res);
  }

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (["host", "connection", "content-length", "authorization"].includes(k)) continue;
    headers[k] = v;
  }
  if (UPSTREAM_AUTH) headers["authorization"] = UPSTREAM_AUTH;

  const hasBody = !["GET", "HEAD"].includes(req.method);
  let body = hasBody ? await readBody(req) : undefined;

  // V1 prompt sends are translated to V2's /prompt endpoint + {text} body.
  const prompt = rewritePrompt(req.method, pathname, body);
  if (prompt) {
    mapped = prompt.path;
    body = prompt.body;
  }

  const target = `${UPSTREAM}${mapped}${query}`;
  log("V1", req.method, pathname, prompt ? "-> V2 prompt" : "-> V2", mapped);

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
      redirect: "manual",
      duplex: body ? "half" : undefined,
    });

    // --- Prompt POSTs: unwrap V2's {data} into a V1 Message -----------------
    if (prompt) {
      const contentType = upstream.headers.get("content-type") || "";
      let json;
      if (contentType.includes("application/json")) {
        json = await upstream.json().catch(() => undefined);
      }
      // Upstream validation errors ({_tag:...}) are surfaced unchanged.
      if (json && typeof json === "object" && json._tag) {
        return sendJson(res, upstream.status, json);
      }
      const data = json && typeof json === "object" && json.data !== undefined ? json.data : json;
      return sendJson(res, upstream.status, promptResultToV1(data, prompt.sessionID));
    }

    // --- Reshaped JSON responses (V1 clients need the old shape) -----------
    if (needsReshape(req.method, pathname)) {
      const contentType = upstream.headers.get("content-type") || "";
      let json;
      if (contentType.includes("application/json")) {
        json = await upstream.json().catch(() => undefined);
      }
      const shaped = json === undefined ? undefined : reshape(pathname, json);
      log("V1", req.method, pathname, shaped === undefined ? "-> passthrough" : "-> reshaped");
      return sendJson(res, upstream.status, shaped === undefined ? json ?? {} : shaped);
    }

    // --- Stream everything else back verbatim (SSE, downloads, ...) --------
    //
    // We must NOT forward content-length: fetch gives us a DECODED body, so any
    // upstream content-length (or transfer-encoding) describes the encoded form
    // and would be wrong. A wrong content-length makes the client read past the
    // response boundary and interpret payload bytes as a status line - which
    // surfaces as "Unexpected status line" in the app. Dropping it lets Node
    // frame the response itself.
    const outHeaders = {};
    upstream.headers.forEach((value, key) => {
      if (["content-encoding", "content-length", "transfer-encoding", "connection"].includes(key)) return;
      outHeaders[key] = value;
    });

    // SSE and similar streams must not be buffered or length-delimited.
    const isStream = (outHeaders["content-type"] || "").includes("text/event-stream");
    if (isStream) {
      outHeaders["cache-control"] = "no-cache";
      outHeaders["x-accel-buffering"] = "no";
    }

    res.writeHead(upstream.status, outHeaders);

    if (!upstream.body) return res.end();

    const reader = upstream.body.getReader();
    const pump = async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.write(Buffer.from(value))) {
            await new Promise((r) => res.once("drain", r));
          }
        }
      } catch (err) {
        log("stream error:", err.message);
      } finally {
        res.end();
      }
    };
    await pump();
  } catch (err) {
    log("upstream error:", err.message);
    if (!res.headersSent) {
      sendJson(res, 502, { error: "upstream unavailable", detail: err.message });
    } else {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[v1v2-bridge] listening on http://${HOST}:${PORT}`);
  console.log(`[v1v2-bridge] upstream          ${UPSTREAM}`);
  console.log(`[v1v2-bridge] upstream auth     ${UPSTREAM_AUTH ? "enabled" : "disabled"}`);
  console.log(`[v1v2-bridge] client auth       ${BRIDGE_USERNAME || BRIDGE_PASSWORD ? "enabled" : "disabled"}`);
  console.log(`[v1v2-bridge] try: curl -u USER:PASS http://127.0.0.1:${PORT}/global/health`);
});
