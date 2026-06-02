const { getPrincipal, isInItTeam, fsGetConversations, fsRequest } = require("../shared/clients");

module.exports = async function(context, req) {
  const principal = getPrincipal(req);
  if (!isInItTeam(principal)) { context.res = { status:403, body:{error:"Not authorized"} }; return; }

  const { ticketId, type = "conversations" } = req.query;
  if (!ticketId) { context.res = { status:400, body:{error:"ticketId required"} }; return; }

  try {
    if (type === "activities") {
      // Fetch ticket activities (status changes, assignments, notes etc.)
      const data = await fsRequest(`/tickets/${ticketId}/activities`);
      const activities = (data.activities || []).sort((a,b) => new Date(a.created_at) - new Date(b.created_at));
      context.res = { body: { activities } };
    } else {
      // Default: fetch conversations (replies + notes)
      const conversations = await fsGetConversations(ticketId);
      const sorted = conversations.sort((a,b) => new Date(a.created_at) - new Date(b.created_at));
      context.res = { body: { conversations: sorted } };
    }
  } catch(err) {
    context.log.error("ticketThread failed", err);
    context.res = { status:500, body:{error:err.message} };
  }
};
