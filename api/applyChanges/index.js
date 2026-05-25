const { getPrincipal, isInItTeam, fsUpdateTicket, fsGetAgentMap } = require("../shared/clients");
const PRIO_NAME_TO_NUM = { Low:1, Medium:2, High:3, Urgent:4 };
const STATUS_NAME_TO_NUM = { Open:2, Pending:3, Resolved:4, Closed:5, Hold:6 };

module.exports = async function(context, req) {
  const principal = getPrincipal(req);
  if (!isInItTeam(principal)) { context.res = { status: 403, body: { error: "Not authorized" } }; return; }
  const { changes } = req.body || {};
  if (!Array.isArray(changes) || !changes.length) { context.res = { status: 400, body: { error: "No changes" } }; return; }
  let agentMap;
  try { agentMap = await fsGetAgentMap(); } catch(err) { context.res = { status: 500, body: { error: "Could not load agents" } }; return; }
  const agentByName = {};
  Object.values(agentMap).forEach(a => { agentByName[a.name.toLowerCase()] = a.id; if(a.email) agentByName[a.email.toLowerCase()] = a.id; });
  const results = [];
  for (const { ticketId, fields } of changes) {
    if (!ticketId || !fields) { results.push({ ticketId, ok: false, error: "Missing ticketId or fields" }); continue; }
    const payload = {};
    if (fields.status) { payload.status = typeof fields.status === "number" ? fields.status : STATUS_NAME_TO_NUM[fields.status]; }
    if (fields.priority) { payload.priority = typeof fields.priority === "number" ? fields.priority : PRIO_NAME_TO_NUM[fields.priority]; }
    if (fields.responder_name) { const id = agentByName[fields.responder_name.toLowerCase()]; if (id) payload.responder_id = id; }
    if (fields.category) payload.category = fields.category;
    if (fields.sub_category) payload.sub_category = fields.sub_category;
    try { await fsUpdateTicket(ticketId, payload); results.push({ ticketId, ok: true, applied: payload }); }
    catch(err) { results.push({ ticketId, ok: false, error: err.message }); }
  }
  context.res = { body: { results } };
};
