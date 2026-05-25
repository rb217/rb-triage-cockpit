const { getPrincipal, isInItTeam, fsGetAllOpenTickets, fsGetClosedTickets, fsGetAgentMap } = require("../shared/clients");

module.exports = async function(context, req) {
  const principal = getPrincipal(req);
  if (!isInItTeam(principal)) {
    context.res = { status: 403, body: { error: "Not authorized" } };
    return;
  }
  const includeClosed = req.query.includeClosed === "true";
  try {
    const [open, closed, agents] = await Promise.all([
      fsGetAllOpenTickets(),
      includeClosed ? fsGetClosedTickets(200) : Promise.resolve([]),
      fsGetAgentMap()
    ]);
    const enrich = t => ({ ...t, responder_name: t.responder_id ? agents[t.responder_id]?.name || null : null });
    context.res = { body: { open: open.map(enrich), closed: closed.map(enrich), fetchedAt: new Date().toISOString() } };
  } catch(err) {
    context.log.error("tickets failed", err);
    context.res = { status: 500, body: { error: err.message } };
  }
};
