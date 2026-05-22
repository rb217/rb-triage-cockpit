// api/applyChanges/index.js
// POST /api/applyChanges
// Body: { changes: [{ticketId, fields:{status, priority, responder_name, category, sub_category}}, ...] }
// Resolves assignee names to agent IDs, then PUTs each ticket update.

const { app } = require("@azure/functions");
const {
  getPrincipal, isInItTeam,
  fsUpdateTicket, fsGetAgentMap
} = require("../shared/clients");

const PRIO_NAME_TO_NUM = { Low: 1, Medium: 2, High: 3, Urgent: 4 };
const STATUS_NAME_TO_NUM = { Open: 2, Pending: 3, Resolved: 4, Closed: 5, Hold: 6 };

app.http("applyChanges", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    const principal = getPrincipal(request);
    if (!isInItTeam(principal)) {
      return { status: 403, jsonBody: { error: "Not authorized" } };
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return { status: 400, jsonBody: { error: "Invalid JSON body" } };
    }

    const { changes } = body;
    if (!Array.isArray(changes) || !changes.length) {
      return { status: 400, jsonBody: { error: "No changes provided" } };
    }

    // Build agent name → ID map once
    let agentMap;
    try {
      agentMap = await fsGetAgentMap();
    } catch (err) {
      return { status: 500, jsonBody: { error: "Could not load agents: " + err.message } };
    }
    const agentByName = {};
    Object.values(agentMap).forEach(a => {
      agentByName[a.name.toLowerCase()] = a.id;
      if (a.email) agentByName[a.email.toLowerCase()] = a.id;
    });

    const results = [];
    for (const change of changes) {
      const { ticketId, fields } = change;
      if (!ticketId || !fields || typeof fields !== "object") {
        results.push({ ticketId, ok: false, error: "Missing ticketId or fields" });
        continue;
      }

      // Translate human-readable values to Freshservice IDs
      const payload = {};
      if (fields.status) {
        payload.status = typeof fields.status === "number"
          ? fields.status
          : STATUS_NAME_TO_NUM[fields.status];
        if (!payload.status) {
          results.push({ ticketId, ok: false, error: `Unknown status: ${fields.status}` });
          continue;
        }
      }
      if (fields.priority) {
        payload.priority = typeof fields.priority === "number"
          ? fields.priority
          : PRIO_NAME_TO_NUM[fields.priority];
        if (!payload.priority) {
          results.push({ ticketId, ok: false, error: `Unknown priority: ${fields.priority}` });
          continue;
        }
      }
      if (fields.responder_name) {
        const id = agentByName[fields.responder_name.toLowerCase()];
        if (!id) {
          results.push({ ticketId, ok: false, error: `Unknown agent: ${fields.responder_name}` });
          continue;
        }
        payload.responder_id = id;
      }
      if (fields.category) payload.category = fields.category;
      if (fields.sub_category) payload.sub_category = fields.sub_category;

      if (!Object.keys(payload).length) {
        results.push({ ticketId, ok: false, error: "No actionable fields" });
        continue;
      }

      try {
        await fsUpdateTicket(ticketId, payload);
        results.push({ ticketId, ok: true, applied: payload });
        context.log(`Updated ticket ${ticketId}: ${JSON.stringify(payload)} by ${principal?.userDetails || "?"}`);
      } catch (err) {
        results.push({ ticketId, ok: false, error: err.message });
      }
    }

    return { jsonBody: { results } };
  }
});
