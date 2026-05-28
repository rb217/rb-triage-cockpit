const { getPrincipal, isInItTeam, fsAddNote } = require("../shared/clients");

// ConnectWise Control — RESTful API Manager extension
// Uses CTRLAuthHeader + Origin headers (NOT Basic auth)
// Endpoint: /App_Extensions/{guid}/Service.ashx/{method}

const SC_BASE   = () => (process.env.SCREENCONNECT_URL || "").replace(/\/$/, "");
const SC_GUID   = () => process.env.SCREENCONNECT_EXTENSION_GUID || "";
const SC_SECRET = () => process.env.SCREENCONNECT_SECRET || "";
const SC_ORIGIN = () => process.env.SCREENCONNECT_ORIGIN || process.env.SCREENCONNECT_URL || "";

function extUrl(method) {
  return `${SC_BASE()}/App_Extensions/${SC_GUID()}/Service.ashx/${method}`;
}

function extHeaders() {
  return {
    "Content-Type": "application/json",
    "CTRLAuthHeader": SC_SECRET(),
    "Origin": SC_ORIGIN()
  };
}

// All extension calls are POST (even reads — SC extension requires POST)
async function extCall(method, body = []) {
  const url = extUrl(method);
  const res = await fetch(url, {
    method: "POST",
    headers: extHeaders(),
    body: JSON.stringify(body)
  });
  if (res.status === 401) throw new Error("Auth failed — check SCREENCONNECT_SECRET (CTRLAuthHeader token)");
  if (res.status === 403) throw new Error("Forbidden — token may be wrong or Origin header mismatch");
  if (!res.ok) throw new Error(`SC extension ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch(e) { return text; }
}

function normalizeSession(s) {
  // Extension returns arrays: [SessionID, Name, IsPublic, Code, GuestMachineInfo, ConnectedCount, ...]
  if (Array.isArray(s)) {
    const id = s[0];
    const name = s[1] || "Unknown";
    const connCount = typeof s[5] === "number" ? s[5] : (s[5] || 0);
    return {
      sessionId: id,
      name,
      isActive: connCount > 0,
      activeConnections: connCount,
      guestMachineName: s[4]?.MachineName || s[4]?.GuestMachineName || "",
      guestOs: s[4]?.OperatingSystemName || "",
      launchUrl: id ? `${SC_BASE()}/Host#Access/${id}` : null
    };
  }
  // Object format (some SC versions)
  const id = s.SessionID || s.sessionId;
  return {
    sessionId: id,
    name: s.Name || s.GuestMachineName || "Unknown",
    isActive: (s.ActiveConnectionCount || s.GuestConnectedCount || 0) > 0,
    activeConnections: s.ActiveConnectionCount || s.GuestConnectedCount || 0,
    guestMachineName: s.GuestMachineName || "",
    guestOs: s.GuestOperatingSystemName || "",
    launchUrl: id ? `${SC_BASE()}/Host#Access/${id}` : null
  };
}

async function findSessionsByName(query) {
  // GetSessionsByName takes [sessionType, sessionGroupPath, name, maxResults]
  // sessionType 2 = Access sessions
  const result = await extCall("GetSessionsByName", [2, "", query, 20]);
  const sessions = Array.isArray(result) ? result : (result.Sessions || result.sessions || []);
  return sessions.map(normalizeSession);
}

module.exports = async function(context, req) {
  const principal = getPrincipal(req);
  if (!isInItTeam(principal)) {
    context.res = { status: 403, body: { error: "Not authorized" } };
    return;
  }

  const base = SC_BASE(), guid = SC_GUID(), secret = SC_SECRET();

  if (!base || !guid || !secret) {
    context.res = { status: 500, body: { error: "ScreenConnect not configured — need SCREENCONNECT_URL, SCREENCONNECT_EXTENSION_GUID, SCREENCONNECT_SECRET" } };
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
      // Diagnostic — try a minimal extension call
      const tests = {};
      try {
        // GetSessionGroups is a lightweight call to test auth
        const r = await extCall("GetSessionGroups", [2]);
        tests.extension = { ok: true, sample: JSON.stringify(r).slice(0, 200) };
      } catch(e) {
        tests.extension = { ok: false, error: e.message };
      }
      context.res = { body: {
        configured: true,
        hasGuid: !!guid,
        hasSecret: !!secret,
        url: base.replace(/https?:\/\//, "").split("/")[0],
        origin: SC_ORIGIN(),
        extensionUrl: extUrl("GetSessionsByName"),
        tests
      }};
      return;
    }

    if (action === "find" && name) {
      let sessions = await findSessionsByName(name);

      // If no results and name looks like a serial (alphanumeric, 10-12 chars),
      // also try searching by the name directly as a fallback
      if (!sessions.length && name.length > 4) {
        try {
          // Try partial match — some SC versions need just part of the name
          const shortName = name.slice(0, 8);
          const fallback = await findSessionsByName(shortName);
          if (fallback.length) sessions = fallback;
        } catch(e) { /* ignore fallback error */ }
      }

      context.res = { body: { sessions } };
      return;
    }

    context.res = { status: 400, body: { error: "Unknown action or missing params" } };

  } catch(err) {
    context.log.error("screenconnect failed", err);
    context.res = { status: 500, body: { error: err.message } };
  }
};
