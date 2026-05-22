// api/tickets/index.js
// GET /api/tickets?includeClosed=true
// Returns { open: [...], closed: [...] } for the dashboard.

const { app } = require("@azure/functions");
const {
  getPrincipal, isInItTeam,
  fsGetAllOpenTickets, fsGetClosedTickets, fsGetAgentMap
} = require("../shared/clients");

app.http("tickets", {
  methods: ["GET"],
  authLevel: "anonymous", // SWA handles auth via Entra; we re-check the principal
  handler: async (request, context) => {
    const principal = getPrincipal(request);
    if (!isInItTeam(principal)) {
      return { status: 403, jsonBody: { error: "Not authorized" } };
    }

    const includeClosed = new URL(request.url).searchParams.get("includeClosed") === "true";

    try {
      // Fetch in parallel
      const [open, closed, agents] = await Promise.all([
        fsGetAllOpenTickets(),
        includeClosed ? fsGetClosedTickets(200) : Promise.resolve([]),
        fsGetAgentMap()
      ]);

      // Enrich tickets with agent names (Freshservice returns only IDs)
      const enrich = (t) => ({
        ...t,
        responder_name: t.responder_id ? agents[t.responder_id]?.name || null : null
      });

      return {
        jsonBody: {
          open: open.map(enrich),
          closed: closed.map(enrich),
          fetchedAt: new Date().toISOString()
        }
      };
    } catch (err) {
      context.log.error("tickets fetch failed", err);
      return { status: 500, jsonBody: { error: err.message } };
    }
  }
});
