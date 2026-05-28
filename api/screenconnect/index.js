const { getPrincipal, isInItTeam, fsAddNote } = require("../shared/clients");

// ConnectWise Control (ScreenConnect) API
// GET /api/screenconnect?action=find&name=... — find sessions by machine name/serial
// GET /api/screenconnect?action=status        — diagnostic
// POST { action:"note", ... }                 — add session note

const SC_BASE = () => (process.env.SCREENCONNECT_URL || "").replace(/\/$/, "");
const SC_USER = () => process.env.SCREENCONNECT_USER || "";
const SC_PASS = () => process.env.SCREENCONNECT_SECRET || "";

function getBasicAuth() {
  const u = SC_USER(), p = SC_PASS();
  if (!u || !p) return null;
  return "Basic " + Buffer.from(`${u}:${p}`).toString("base64");
}

// Try multiple SC API strategies and return first that works
async function findSessions(query) {
  const base = SC_BASE();
  const auth = getBasicAuth();
  const headers = { "Content-Type": "application/json", "Accept": "application/json" };
  if (auth) headers["Authorization"] = auth;

  const errors = [];

  // Strategy 1: REST API with filter
  try {
    const url = `${base}/api/Sessions?SessionType=Access&filter=${encodeURIComponent(`Name CONTAINS '${query}'`)}&fields=SessionID,Name,GuestMachineName,GuestConnectedCount,ActiveConnectionCount,LastConnectedTime,GuestOperatingSystemName`;
    const res = await fetch(url, { headers });
    if (res.ok) {
      const data = await res.json();
      const sessions = Array.isArray(data) ? data : (data.Sessions || data.sessions || []);
      return sessions.map(s => normalizeRest(s));
    }
    errors.push(`REST: ${res.status} ${await res.text().then(t=>t.slice(0,100))}`);
  } catch(e) { errors.push(`REST: ${e.message}`); }

  // Strategy 2: Report2 API (older SC versions)
  try {
    const url = `${base}/Report2.json?SessionType=Access&GroupBy=&Context=&Filter=${encodeURIComponent(`Name CONTAINS '${query}'`)}&Columns=SessionID,Name,GuestMachineName,ActiveConnectionCount,GuestConnectedCount,LastConnectedTime&StartIndex=0&ItemCount=20`;
    const res = await fetch(url, { headers });
    if (res.ok) {
      const data = await res.json();
      if (data.Rows || data.rows) {
        const rows = data.Rows || data.rows;
        return rows.map(r => normalizeReport(r));
      }
    }
    errors.push(`Report2: ${res.status}`);
  } catch(e) { errors.push(`Report2: ${e.message}`); }

  // Strategy 3: ServiceSubtype filter
  try {
    const url = `${base}/api/Sessions?SessionType=Access&nameFilter=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers });
    if (res.ok) {
      const data = await res.json();
      const sessions = Array.isArray(data) ? data : (data.Sessions || []);
      return sessions.map(s => normalizeRest(s));
    }
    errors.push(`nameFilter: ${res.status}`);
  } catch(e) { errors.push(`nameFilter: ${e.message}`); }

  throw new Error(`All strategies failed: ${errors.join(" | ")}`);
}

function normalizeRest(s) {
  const id = s.SessionID || s.sessionId || s.Id || s.id;
  return {
    sessionId: id,
    name: s.Name || s.GuestMachineName || s.name || "Unknown",
    guestMachineName: s.GuestMachineName || s.guestMachineName,
    guestOs: s.GuestOperatingSystemName || s.guestOperatingSystemName,
    isActive: ((s.ActiveConnectionCount || s.activeConnectionCount || 0) > 0) ||
              ((s.GuestConnectedCount || s.guestConnectedCount || 0) > 0),
    activeConnections: s.ActiveConnectionCount || s.activeConnectionCount || 0,
    lastConnected: s.LastConnectedTime || s.lastConnectedTime,
    launchUrl: id ? `${SC_BASE()}/Host#Access/${id}` : null
  };
}

function normalizeReport(row) {
  // Report rows are arrays: [SessionID, Name, GuestMachineName, ActiveConnectionCount, GuestConnectedCount, LastConnectedTime]
  const id = row[0];
  return {
    sessionId: id,
    name: row[1] || row[2] || "Unknown",
    guestMachineName: row[2],
    isActive: (row[3] || 0) > 0 || (row[4] || 0) > 0,
    activeConnections: row[3] || 0,
    lastConnected: row[5],
    launchUrl: id ? `${SC_BASE()}/Host#Access/${id}` : null
  };
}

module.exports = async function(context, req) {
  const principal = getPrincipal(req);
  if (!isInItTeam(principal)) {
    context.res = { status: 403, body: { error: "Not authorized" } };
    return;
  }

  const base = SC_BASE();
  if (!base) {
    context.res = { status: 500, body: { error: "SCREENCONNECT_URL not configured" } };
    return;
  }

  try {
    if (req.method === "POST") {
      const { action, ticketId, sessionId, summary, agentName, duration } = req.body || {};
      if (action === "note" && ticketId) {
        const note = `[🖥️ ScreenConnect Session]\nAgent: ${agentName||"IT Team"}\nDuration: ${duration||"—"}\n${summary?"Notes: "+summary:""}\nSession: ${sessionId||"—"}`;
        await fsAddNote(ticketId, note, true);
        context.res = { body: { ok: true } };
      } else {
        context.res = { status: 400, body: { error: "Unknown POST action" } };
      }
      return;
    }

    const { action, name } = req.query;

    if (action === "status") {
      // Diagnostic — test auth against each known endpoint
      const auth = getBasicAuth();
      const headers = { "Accept": "application/json" };
      if (auth) headers["Authorization"] = auth;

      const tests = {};

      // Test /api/Sessions
      try {
        const r = await fetch(`${base}/api/Sessions?SessionType=Access&ItemCount=1`, { headers });
        tests.restApi = { status: r.status, ok: r.ok };
        if (r.ok) { const t = await r.text(); tests.restApiSample = t.slice(0, 200); }
      } catch(e) { tests.restApi = { error: e.message }; }

      // Test /Report2.json
      try {
        const r = await fetch(`${base}/Report2.json?SessionType=Access&ItemCount=1`, { headers });
        tests.report2 = { status: r.status, ok: r.ok };
        if (r.ok) { const t = await r.text(); tests.report2Sample = t.slice(0, 200); }
      } catch(e) { tests.report2 = { error: e.message }; }

      context.res = { body: {
        configured: true,
        hasUser: !!SC_USER(),
        hasPass: !!SC_PASS(),
        url: base.replace(/https?:\/\//, "").split("/")[0],
        tests
      }};
      return;
    }

    if (action === "find" && name) {
      const sessions = await findSessions(name);
      context.res = { body: { sessions } };
      return;
    }

    if (action === "active") {
      const auth = getBasicAuth();
      const headers = { "Accept": "application/json" };
      if (auth) headers["Authorization"] = auth;
      try {
        const r = await fetch(`${base}/api/Sessions?SessionType=Access&filter=${encodeURIComponent("ActiveConnectionCount GT 0")}&ItemCount=50`, { headers });
        if (!r.ok) throw new Error(`${r.status}`);
        const data = await r.json();
        const sessions = Array.isArray(data) ? data.map(normalizeRest) : (data.Sessions||[]).map(normalizeRest);
        context.res = { body: { sessions } };
      } catch(e) {
        context.res = { body: { sessions: [], error: e.message } };
      }
      return;
    }

    context.res = { status: 400, body: { error: "Unknown action" } };

  } catch(err) {
    context.log.error("screenconnect failed", err);
    context.res = { status: 500, body: { error: err.message } };
  }
};
