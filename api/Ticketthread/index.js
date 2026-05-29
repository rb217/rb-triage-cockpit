const { getPrincipal, isInItTeam, fsGetConversations, fsGetTicket } = require("../shared/clients");

module.exports = async function(context, req) {
  const principal = getPrincipal(req);
  if (!isInItTeam(principal)) { context.res = { status:403, body:{error:"Not authorized"} }; return; }
  const { ticketId } = req.query;
  if (!ticketId) { context.res = { status:400, body:{error:"ticketId required"} }; return; }
  try {
    const conversations = await fsGetConversations(ticketId);
    // Sort chronologically
    const sorted = conversations.sort((a,b) => new Date(a.created_at) - new Date(b.created_at));
    context.res = { body: { conversations: sorted } };
  } catch(err) {
    context.log.error("ticketThread failed", err);
    context.res = { status:500, body:{error:err.message} };
  }
};
