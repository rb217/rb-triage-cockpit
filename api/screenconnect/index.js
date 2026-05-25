const { getPrincipal, isInItTeam, fsAddNote } = require("../shared/clients");

// GET  /api/screenconnect?action=find&name=...     — find sessions by machine name
// GET  /api/screenconnect?action=active            — all currently active sessions
// GET  /api/screenconnect?action=history&name=...  — session audit history for machine
// GET  /api/screenconnect?action=launchUrl&sessionId=... — generate launch URL
// POST /api/screenconnect { action:"note", ticketId, sessionId, summary } — add post-session note

const SC_BASE = () => process.env.SCREENCONNECT_URL;
const SC_GUID = () => process.env.SCREENCONNECT_EXTENSION_GUID;
const SC_SECRET = () => process.env.SCREENCONNECT_SECRET;
const SC_ORIGIN = () => process.env.SCREENCONNECT_ORIGIN || process.env.SCREENCONNECT_URL;

async function scRequest(endpoint, body) {
  const base = SC_BASE();
  const guid = SC_GUID();
  const secret = SC_SECRET();
  const origin = SC_ORIGIN();

  if (!base || !guid || !secret) throw new Error("ScreenConnect not fully configured (URL, GUID, SECRET required)");

  const url = `${base}/App_Extensions/${guid}/Service.ashx/${endpoint}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CTRLAuthHeader": secret,
      "Origin": origin
    },
    body: JSON.stringify(body || [])
  });

  if (res.status === 401) throw new Error("ScreenConnect auth failed — check SCREENCONNECT_SECRET");
  if (!res.ok) throw new Error(`ScreenConnect ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json().catch(() => []);
}

function sessionToObj(s) {
  if (Array.isArray(s)) {
    // API returns arrays: [SessionID, Name, IsPublic, Code, GuestMachineInfo, ...]
    return {
      sessionId: s[0],
      name: s[1],
      isPublic: s[2],
      code: s[3],
      machineInfo: s[4] || {},
      activeConnections: s[5] || [],
      createdTime: s[6],
      customProperties: s[7] || []
    };
  }
  return s;
}

function isSessionActive(session) {
  const s = sessionToObj(session);
  // Active = has at least one connected guest
  const conns = s.activeConnections || s.ActiveConnections || [];
  return Array.isArray(conns) ? conns.length > 0 : false;
}

function buildLaunchUrl(sessionId) {
  const base = SC_BASE();
  if (!base) return null;
  // ScreenConnect launch URL format
  return `${base}/Access/Host#Access/${sessionId}`;
}

async function findSessionsByName(name) {
  const results = await scRequest("GetSessionsByName", [name, 2, 50]); // type 2 = Access
  return (Array.isArray(results) ? results : []).map(sessionToObj);
}

async function getActiveSessions() {
  try {
    const results = await scRequest("GetActiveSessionsForCurrentUser", [2, 100]); // type 2 = Access
    return (Array.isArray(results) ? results : []).map(sessionToObj);
  } catch(e) {
    // Fallback: try GetSessionsByFilter
    const results = await scRequest("GetSessionsByFilter", ["", 2, "IsGuestConnected = True", 0, 50]);
    return (Array.isArray(results) ? results : []).map(sessionToObj);
  }
}

async function getSessionHistory(name, daysBack = 30) {
  try {
    const results = await scRequest("GetSessionAuditEntries", [
      new Date(Date.now() - daysBack * 86400000).toISOString(),
      new Date().toISOString(),
      name
    ]);
    return Array.isArray(results) ? results.slice(0, 20) : [];
  } catch(e) {
    return [];
  }
}

module.exports = async function(context, req) {
  const principal = getPrincipal(req);
  if (!isInItTeam(principal)) {
    context.res = { status: 403, body: { error: "Not authorized" } };
    return;
  }

  try {
    if (req.method === "GET") {
      const { action, name, sessionId } = req.query;

      if (action === "find" && name) {
        const sessions = await findSessionsByName(name);
        const enriched = sessions.map(s => ({
          ...s,
          isActive: isSessionActive(s),
          launchUrl: buildLaunchUrl(s.sessionId)
        }));
        context.res = { body: { sessions: enriched } };

      } else if (action === "active") {
        const sessions = await getActiveSessions();
        context.res = { body: { sessions: sessions.map(s => ({ ...s, launchUrl: buildLaunchUrl(s.sessionId) })) } };

      } else if (action === "history" && name) {
        const history = await getSessionHistory(name, 30);
        context.res = { body: { history } };

      } else if (action === "launchUrl" && sessionId) {
        context.res = { body: { launchUrl: buildLaunchUrl(sessionId), sessionId } };

      } else if (action === "status") {
        // Quick health check — just try to get active sessions
        const sessions = await getActiveSessions();
        context.res = { body: { ok: true, activeSessions: sessions.length } };

      } else {
        context.res = { status: 400, body: { error: "Unknown action or missing params" } };
      }

    } else {
      const { action, ticketId, sessionId, summary, agentName, duration } = req.body || {};

      if (action === "note" && ticketId) {
        const note = `[🖥️ ScreenConnect Session]\nAgent: ${agentName || "IT Team"}\nDuration: ${duration || "—"}\n${summary ? "Notes: " + summary : ""}\nSession ID: ${sessionId || "—"}`;
        await fsAddNote(ticketId, note, true);
        context.res = { body: { ok: true } };
      } else {
        context.res = { status: 400, body: { error: "Unknown action" } };
      }
    }
  } catch(err) {
    context.log.error("screenconnect failed", err);
    context.res = { status: 500, body: { error: err.message } };
  }
};
