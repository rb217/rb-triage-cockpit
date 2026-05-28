const { getPrincipal, isInItTeam, fsAddNote } = require("../shared/clients");

// ConnectWise Control — RESTful API Manager extension
// GET methods: GetSessionsByName, GetSessionDetailsBySessionID, GetSessionBySessionID
// POST methods: UpdateSessionCustomProperties, SendCommandToSession
// Auth: CTRLAuthHeader + Origin

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

// GET with body — SC extension uses GET for reads but still accepts body params
async function extGet(method, bodyParams = []) {
  const url = extUrl(method);
  const res = await fetch(url, {
    method: "POST",
    headers: extHeaders(),
    body: JSON.stringify(bodyParams)
  });

  if (res.status === 401) throw new Error("Auth failed — check SCREENCONNECT_SECRET");
  if (res.status === 403) throw new Error("Forbidden — check SCREENCONNECT_ORIGIN matches your SC instance URL");
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SC ${res.status}: ${text.slice(0, 300)}`);
  }

  const text = await res.text();
  try { return JSON.parse(text); } catch(e) { return text; }
}

function normalizeSession(s) {
  if (Array.isArray(s)) {
    // Array format: [SessionID, Name, IsPublic, Code, GuestMachineInfo, ConnectedCount, ...]
    const id = s[0];
    const guestInfo = s[4] || {};
    return {
      sessionId: id,
      name: s[1] || "Unknown",
      isActive: (s[5] || 0) > 0,
      activeConnections: s[5] || 0,
      guestMachineName: guestInfo.MachineName || guestInfo.GuestMachineName || s[2] || "",
      guestOs: guestInfo.OperatingSystemName || "",
      launchUrl: id ? `${SC_BASE()}/Host#Access/${id}` : null
    };
  }
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
  // GetSessionsByName params: [sessionType, sessionGroupPath, nameFilter, maxResults]
  // sessionType: 0=Support, 1=Meeting, 2=Access — we want Access (2)
  const result = await extGet("GetSessionsByName", [2, "", query, 25]);
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
    context.res = { status: 500, body: { error: "SC not configured — need SCREENCONNECT_URL, SCREENCONNECT_EXTENSION_GUID, SCREENCONNECT_SECRET" } };
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
      // Diagnostic — use GetSessionsByName with empty string to list recent sessions
      const tests = {};
      try {
        const r = await extGet("GetSessionsByName", [2, "", "", 5]);
        tests.GetSessionsByName = { ok: true, count: Array.isArray(r) ? r.length : "non-array", sample: JSON.stringify(r).slice(0, 300) };
      } catch(e) {
        tests.GetSessionsByName = { ok: false, error: e.message };
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

      // Also try device name fallback if serial returns nothing
      if (!sessions.length && name.length > 6) {
        try {
          const short = name.slice(0, 8);
          if (short !== name) {
            const fallback = await findSessionsByName(short);
            if (fallback.length) sessions = fallback;
          }
        } catch(e) { /* ignore */ }
      }

      context.res = { body: { sessions } };
      return;
    }

    if (action === "active") {
      // All access sessions (empty name filter = all)
      const sessions = await findSessionsByName("");
      const active = sessions.filter(s => s.isActive);
      context.res = { body: { sessions: active } };
      return;
    }

    context.res = { status: 400, body: { error: "Unknown action" } };

  } catch(err) {
    context.log.error("screenconnect failed", err);
    context.res = { status: 500, body: { error: err.message } };
  }
};
