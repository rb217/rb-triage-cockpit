const { getPrincipal, isInItTeam, fsRequest, callClaude, parseJsonResponse } = require("../shared/clients");

// GET  /api/requesterProfile?email=...
// POST /api/requesterProfile { email, brand } — store brand assignment

const BRAND_DOMAINS = {
  "americantinceiling.com": "American Tin Ceilings",
  "baseboarders.com": "Baseboarders",
  "ventcoversunlimited.com": "Vent Covers Unlimited",
  "madelyncarter.com": "Madelyn Carter",
  "trueformconcrete.com": "Trueform Concrete",
  "rtacabinetstore.com": "RTA Cabinet Store",
  "reggioregister.com": "Reggio Registers",
  "hearthbrands.com": "Hearth Brands"
  // renovationbrands.com and unknowns → prompt user
};

function detectBrand(email) {
  if (!email) return null;
  const domain = email.split("@")[1]?.toLowerCase();
  return BRAND_DOMAINS[domain] || null;
}

async function buildProfile(email) {
  // Fetch requester info + their tickets
  const reqData = await fsRequest(`/requesters?email=${encodeURIComponent(email)}`);
  const requester = reqData.requesters?.[0];
  if (!requester) return null;

  // Get their recent tickets
  const ticketData = await fsRequest(`/tickets?requester_id=${requester.id}&per_page=100&order_by=created_at&order_type=desc`);
  const tickets = ticketData.tickets || [];

  if (!tickets.length) return { requester, tickets: [], profile: null, brand: detectBrand(email) };

  // Compute stats
  const total = tickets.length;
  const byCategory = {};
  const byPriority = { 1:0, 2:0, 3:0, 4:0 };
  const statusCounts = { resolved:0, closed:0, open:0, other:0 };
  let sumResolutionHours = 0, resolvedCount = 0;
  const PRIO_MAP = {1:"Low",2:"Medium",3:"High",4:"Urgent"};
  const STATUS_RESOLVED = new Set([4,5]);

  tickets.forEach(t => {
    const cat = t.category || "Uncategorized";
    byCategory[cat] = (byCategory[cat] || 0) + 1;
    byPriority[t.priority] = (byPriority[t.priority] || 0) + 1;
    if (t.status === 4 || t.status === 5) {
      statusCounts.resolved++;
      if (t.stats?.resolved_at && t.created_at) {
        const hrs = (new Date(t.stats.resolved_at) - new Date(t.created_at)) / 3600000;
        if (hrs > 0 && hrs < 720) { sumResolutionHours += hrs; resolvedCount++; }
      }
    } else if (t.status === 2 || t.status === 3 || t.status === 6) {
      statusCounts.open++;
    }
  });

  const avgResolutionHours = resolvedCount ? Math.round(sumResolutionHours / resolvedCount) : null;
  const topCategory = Object.entries(byCategory).sort((a,b)=>b[1]-a[1])[0]?.[0];
  const recentTickets = tickets.slice(0, 5);

  // First ticket date
  const firstTicketDate = tickets[tickets.length-1]?.created_at;
  const daysSinceFirst = firstTicketDate
    ? Math.round((Date.now() - new Date(firstTicketDate)) / 86400000)
    : null;
  const ticketsPer30Days = daysSinceFirst ? Math.round((total / daysSinceFirst) * 30 * 10) / 10 : null;

  // AI risk assessment
  let aiAssessment = null;
  if (tickets.length >= 3) {
    const prompt = `Analyze this IT requester's ticket history and return ONLY JSON.

Requester: ${requester.first_name} ${requester.last_name} (${email})
Total tickets: ${total}
Avg resolution time: ${avgResolutionHours ? avgResolutionHours + "h" : "unknown"}
Top category: ${topCategory}
Tickets per 30 days: ${ticketsPer30Days}
Recent tickets: ${recentTickets.map(t=>`#${t.id} ${t.subject} (${t.category||"?"})`).join(", ")}

Return:
{
  "riskLevel": "<low|medium|high>",
  "riskReason": "<1 sentence>",
  "pattern": "<key pattern observed, e.g. 'Frequent password resets suggest training gap'>",
  "recommendation": "<1 actionable suggestion for IT>",
  "userErrorRate": <0-100>,
  "trainingOpportunity": <true|false>
}`;
    try {
      aiAssessment = parseJsonResponse(await callClaude(prompt, { maxTokens: 500 }));
    } catch(e) {}
  }

  return {
    requester,
    brand: detectBrand(email),
    needsBrandPrompt: !detectBrand(email) && (email?.split("@")[1]?.toLowerCase() === "renovationbrands.com" || !BRAND_DOMAINS[email?.split("@")[1]?.toLowerCase()]),
    stats: {
      total,
      ticketsPer30Days,
      avgResolutionHours,
      topCategory,
      byCategory,
      byPriority,
      statusCounts,
      daysSinceFirst
    },
    aiAssessment,
    recentTickets
  };
}

module.exports = async function(context, req) {
  const principal = getPrincipal(req);
  if (!isInItTeam(principal)) { context.res = { status: 403, body: { error: "Not authorized" } }; return; }

  try {
    if (req.method === "GET") {
      const email = req.query.email;
      if (!email) { context.res = { status: 400, body: { error: "email required" } }; return; }
      const profile = await buildProfile(email);
      if (!profile) { context.res = { body: { found: false } }; return; }
      context.res = { body: { found: true, ...profile } };
    } else {
      // POST: store brand assignment (we just return it — storage is client-side)
      const { email, brand } = req.body || {};
      if (!email || !brand) { context.res = { status: 400, body: { error: "email and brand required" } }; return; }
      // Optionally update requester's job_title or custom field in Freshservice
      context.res = { body: { ok: true, email, brand } };
    }
  } catch(err) {
    context.log.error("requesterProfile failed", err);
    context.res = { status: 500, body: { error: err.message } };
  }
};
