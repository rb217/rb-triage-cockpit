const { getPrincipal, isInItTeam, fsReplyToTicket, fsAddNote } = require("../shared/clients");
module.exports = async function(context, req) {
  const principal = getPrincipal(req);
  if (!isInItTeam(principal)) { context.res = { status: 403, body: { error: "Not authorized" } }; return; }
  const { ticketId, body, isAutoSend, draftConfidence } = req.body || {};
  if (!ticketId || !body) { context.res = { status: 400, body: { error: "ticketId and body required" } }; return; }
  try {
    await fsReplyToTicket(ticketId, body);
    const note = isAutoSend ? `[🤖 Auto-Reply]\nConfidence: ${draftConfidence||"?"}%` : `[✉ Reply sent by ${principal?.userDetails||"agent"}]\nDrafted with AI assistance`;
    try { await fsAddNote(ticketId, note, true); } catch(e) {}
    context.res = { body: { ok: true, ticketId } };
  } catch(err) { context.res = { status: 500, body: { error: err.message } }; }
};
