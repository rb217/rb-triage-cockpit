// api/patternsScheduled/index.js
// Timer trigger: runs every weekday morning at 7:00 AM US Eastern (12:00 UTC).
// Detects patterns across open tickets and posts an Adaptive Card to Teams.

const { app } = require("@azure/functions");
const {
  fsGetAllOpenTickets, fsGetAgentMap,
  callClaude, parseJsonResponse,
  postTeamsCard
} = require("../shared/clients");

const PRIO_MAP = { 1: "Low", 2: "Medium", 3: "High", 4: "Urgent" };
const SEVERITY_COLORS = { high: "Attention", med: "Warning", low: "Accent" };

function buildPatternPrompt(tickets) {
  return `You are an IT operations analyst at Renovation Brands. Look across these open IT tickets and detect PATTERNS or CLUSTERS — issues that affect multiple users, point to a common root cause, or signal a systemic problem (not isolated complaints). Examples: "3 tickets about wifi in the same conference room" (likely AP issue), "5 NetSuite errors in 24h" (likely integration failure).

Return ONLY a JSON array. Empty array if no meaningful patterns. Aim for 0-5 patterns.

TICKETS:
${tickets.map(t => `---
ID: ${t.id} | ${PRIO_MAP[t.priority]} | ${t.category || ""} / ${t.sub_category || ""}
Subject: ${t.subject}
Desc: ${(t.description_text || "").slice(0, 250)}
Requester: ${t.requester_name || "?"}`).join("\n")}

Return JSON only:
[{"tag":"<2-3 word label>","title":"<headline>","description":"<2-3 sentences>","severity":"<low|med|high>","ticketIds":[<id1>,<id2>],"recommendation":"<concrete action>"}]

Only report patterns where 2+ tickets share a probable root cause.`;
}

function buildTeamsCard(patterns, ticketCount) {
  const sortedPatterns = [...patterns].sort((a, b) => {
    const order = { high: 0, med: 1, low: 2 };
    return (order[a.severity] || 3) - (order[b.severity] || 3);
  });

  const blocks = [
    {
      type: "TextBlock",
      text: "🔍 Morning Pattern Report",
      weight: "Bolder",
      size: "Large",
      color: "Accent"
    },
    {
      type: "TextBlock",
      text: `Analyzed **${ticketCount} open tickets** · ${patterns.length} cluster${patterns.length === 1 ? "" : "s"} detected`,
      isSubtle: true,
      wrap: true,
      spacing: "Small"
    }
  ];

  if (!patterns.length) {
    blocks.push({
      type: "TextBlock",
      text: "No meaningful patterns this morning. Tickets look like isolated issues. ☕",
      wrap: true,
      spacing: "Medium"
    });
  } else {
    sortedPatterns.forEach((p, idx) => {
      blocks.push({
        type: "Container",
        separator: idx > 0,
        spacing: "Medium",
        items: [
          {
            type: "ColumnSet",
            columns: [
              {
                type: "Column",
                width: "auto",
                items: [{
                  type: "TextBlock",
                  text: (p.severity || "low").toUpperCase(),
                  weight: "Bolder",
                  size: "Small",
                  color: SEVERITY_COLORS[p.severity] || "Default"
                }]
              },
              {
                type: "Column",
                width: "stretch",
                items: [{
                  type: "TextBlock",
                  text: `**${p.title}**`,
                  wrap: true,
                  size: "Medium"
                }]
              }
            ]
          },
          {
            type: "TextBlock",
            text: p.description,
            wrap: true,
            spacing: "Small",
            isSubtle: true
          },
          {
            type: "TextBlock",
            text: `🛠️ **Recommendation:** ${p.recommendation}`,
            wrap: true,
            spacing: "Small"
          },
          {
            type: "TextBlock",
            text: `🎫 Tickets: ${p.ticketIds.map(id => `#${id}`).join(", ")}`,
            wrap: true,
            spacing: "Small",
            size: "Small",
            isSubtle: true
          }
        ]
      });
    });
  }

  blocks.push({
    type: "TextBlock",
    text: `_Generated ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} · [Open dashboard](https://${process.env.SWA_DOMAIN || "triage.renovationbrands.com"})_`,
    isSubtle: true,
    size: "Small",
    spacing: "Medium",
    wrap: true
  });

  return {
    type: "message",
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive",
      contentUrl: null,
      content: {
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        type: "AdaptiveCard",
        version: "1.4",
        body: blocks
      }
    }]
  };
}

app.timer("patternsScheduled", {
  // Weekdays at 7:00 AM US Eastern = 12:00 UTC (during DST) or 13:00 UTC (standard time)
  // Using 12:00 UTC year-round means it posts at 7am DST / 8am EST
  // Format: {second} {minute} {hour} {day} {month} {day-of-week}
  schedule: "0 0 12 * * 1-5",
  handler: async (timer, context) => {
    context.log("Pattern detection starting");
    try {
      const [tickets, agentMap] = await Promise.all([
        fsGetAllOpenTickets(),
        fsGetAgentMap()
      ]);

      const enriched = tickets.map(t => ({
        ...t,
        responder_name: t.responder_id ? agentMap[t.responder_id]?.name || null : null
      }));

      if (enriched.length < 3) {
        context.log(`Only ${enriched.length} tickets — skipping pattern detection`);
        return;
      }

      const prompt = buildPatternPrompt(enriched);
      const raw = await callClaude(prompt, { maxTokens: 2000 });
      const patterns = parseJsonResponse(raw);

      context.log(`Detected ${patterns.length} patterns`);

      const card = buildTeamsCard(patterns, enriched.length);
      await postTeamsCard(card);

      context.log("Posted to Teams successfully");
    } catch (err) {
      context.log.error("Pattern detection failed", err);
      // Don't throw — let the next run try again
    }
  }
});
