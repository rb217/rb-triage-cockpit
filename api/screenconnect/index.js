const { getPrincipal, isInItTeam, fsAddNote } = require("../shared/clients");

// ConnectWise Control (ScreenConnect) API
// GET /api/screenconnect?action=find&name=... — find sessions by machine name/serial
// GET /api/screenconnect?action=active        — all active sessions
// POST { action:"note", ticketId, ... }       — add session note to ticket

const SC_BASE = () => (process.env.SCREENCONNECT_URL || "").replace(/\/$/, "");
const SC_USER = () => process.env.SCREENCONNECT_USER || "";
const SC_PASS = () => process.env.SCREENCONNECT_SECRET || "";
const SC_GUID = () => process.env.SCREENCONNECT_EXTENSION_GUID || "";

function getAuthHeader() {
  const user = SC_USER();
  const pass = SC_PASS();
  if (!user || !pass) return null;
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

async function scGet(path) {
  const base = SC_BASE();
  if (!base) throw new Error("SCREENCONNECT_URL not configured");

  const auth = getAuthHeader();
  const headers = { "Content-Type": "application/json" };
  if (auth) headers["Authorization"] = auth;

  const res = await fetch(`${base}${path}`, { headers });
  if (res.status === 401) throw new Error("ScreenConnect auth failed — check SCREENCONNECT_USER and SCREENCONNECT_SECRET");
  if (!res.ok) throw new Error(`ScreenConnect ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch(e) { return text; }
}

// ConnectWise Control REST API v1
async function findSessions(query) {
  try {
    // Try REST API first
    const encoded = encodeURIComponent(query);
    const data = await scGet(`/api/Sessions?filter=Name+CONTAINS+'${encoded}'+OR+CustomProperty0+CONTAINS+'${encoded}'&type=Access&limit=20`);
    if (Array.isArray(data)) return data.map(normalizeSession);
    if (data?.Sessions) return data.Sessions.map(normalizeSession);
  } catch(e1) {
    // Fall back to report API
    try {
      const data = await scGet(`/Report2.json?SessionType=Access&GroupBy=&Context=&Filter=Name+CONTAINS+'${encodeURIComponent(query)}'&Columns=SessionID,Name,GuestMachineName,GuestConnectedCount,ActiveSessionCount&StartIndex=0&ItemCount=20`);
      if (data?.Rows) return data.Rows.map(normalizeReportRow);
    } catch(e2) {
      throw new Error(`SC find failed: ${e1.message}`);
    }
  }
  return [];
}

function normalizeSession(s) {
  // Handle both REST and report formats
  if (Array.isArray(s)) {
    return {
      sessionId: s[0],
      name: s[1] || s[2] || "Unknown",
      isActive: (s[4] || 0) > 0 || (s[3] || 0) > 0,
      activeConnections: s[4] || 0,
      launchUrl: buildLaunchUrl(s[0])
    };
  }
  return {
    sessionId: s.SessionID || s.sessionId || s.Id,
    name: s.Name || s.GuestMachineName || "Unknown",
    isActive: (s.ActiveConnectionCount || s.GuestConnectedCount || 0) > 0,
    activeConnections: s.ActiveConnectionCount || s.GuestConnectedCount || 0,
    guestMachineName: s.GuestMachineName,
    guestOs: s.GuestOperatingSystemName,
    lastConnected: s.LastConnectedTime,
    launchUrl: buildLaunchUrl(s.SessionID || s.sessionId || s.Id)
  };
}

function normalizeReportRow(row) {
  return {
    sessionId: row[0],
    name: row[1] || "Unknown",
    guestMachineName: row[2],
    isActive: (row[3] || 0) > 0 || (row[4] || 0) > 0,
    activeConnections: row[4] || 0,
    launchUrl: buildLaunchUrl(row[0])
  };
}

function buildLaunchUrl(sessionId) {
  if (!sessionId) return null;
  const base = SC_BASE();
  if (!base) return null;
  return `${base}/Host#Access/${sessionId}`;
}

module.exports = async function(context, req) {
  const principal = getPrincipal(req);
  if (!isInItTeam(principal)) {
    context.res = { status: 403, body: { error: "Not authorized" } };
    return;
  }

  try {
    if (req.method === "POST") {
      const { action, ticketId, sessionId, summary, agentName, duration } = req.body || {};
      if (action === "note" && ticketId) {
        const note = `[🖥️ ScreenConnect Session]\nAgent: ${agentName || "IT Team"}\nDuration: ${duration || "—"}\n${summary ? "Notes: " + summary : ""}\nSession ID: ${sessionId || "—"}`;
        await fsAddNote(ticketId, note, true);
        context.res = { body: { ok: true } };
      } else {
        context.res = { status: 400, body: { error: "Unknown action" } };
      }
      return;
    }

    const { action, name } = req.query;

    if (action === "find" && name) {
      const sessions = await findSessions(name);
      context.res = { body: { sessions } };

    } else if (action === "active") {
      try {
        const data = await scGet("/api/Sessions?filter=ActiveConnectionCount+GT+0&type=Access&limit=50");
        const sessions = Array.isArray(data) ? data.map(normalizeSession) :
                         data?.Sessions ? data.Sessions.map(normalizeSession) : [];
        context.res = { body: { sessions } };
      } catch(e) {
        context.res = { body: { sessions: [], error: e.message } };
      }

    } else if (action === "status") {
      const base = SC_BASE();
      context.res = { body: {
        configured: !!base,
        hasAuth: !!(SC_USER() && SC_PASS()),
        hasGuid: !!SC_GUID(),
        url: base ? base.replace(/https?:\/\//, "").split("/")[0] : null
      }};

    } else {
      context.res = { status: 400, body: { error: "Unknown action or missing params" } };
    }
  } catch(err) {
    context.log.error("screenconnect failed", err);
    context.res = { status: 500, body: { error: err.message } };
  }
};
