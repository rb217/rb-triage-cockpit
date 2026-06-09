const { getPrincipal, isInItTeam, fsRequest, callClaude, parseJsonResponse } = require("../shared/clients");

// GET  /api/knowledgeBase?action=list          — all solution articles
// GET  /api/knowledgeBase?action=search&q=...  — AI-powered KB search
// POST /api/knowledgeBase { action:"create", title, description, articleBody, folderId }

module.exports = async function(context, req) {
  const principal = getPrincipal(req);
  if (!isInItTeam(principal)) {
    context.res = { status: 403, body: { error: "Not authorized" } };
    return;
  }

  const action = req.query.action || (req.body && req.body.action);

  // ── List all articles ──────────────────────────────────────────────────
  if (!action || action === "list") {
    try {
      // Freshservice solution articles endpoint
      const data = await fsRequest("/solutions/articles?per_page=100&sort_by=updated_at&sort_order=desc");
      const articles = (data.articles || []).map(a => ({
        id: a.id,
        title: a.title,
        description: a.description,
        article_type: a.article_type,
        status: a.status, // 1=draft, 2=published
        folder_id: a.folder_id,
        tags: a.tags || [],
        updated_at: a.updated_at,
        created_at: a.created_at,
        views: a.views,
        thumbs_up: a.thumbs_up,
        thumbs_down: a.thumbs_down,
      }));
      context.res = { body: { articles } };
    } catch(err) {
      context.log.error("KB list failed:", err.message);
      // Try alternate endpoint if first fails
      try {
        const data2 = await fsRequest("/solutions/articles?per_page=100");
        context.res = { body: { articles: data2.articles || [] } };
      } catch(err2) {
        context.res = { status: 500, body: { error: err.message, hint: "Check Freshservice API key and plan supports Knowledge Base" } };
      }
    }
    return;
  }

  // ── AI-powered search ─────────────────────────────────────────────────
  if (action === "search") {
    const query = req.query.q || req.body?.query;
    if (!query) { context.res = { status: 400, body: { error: "q required" } }; return; }
    if (!process.env.ANTHROPIC_API_KEY) {
      context.res = { status: 503, body: { error: "ANTHROPIC_API_KEY not configured" } };
      return;
    }
    try {
      const listData = await fsRequest("/solutions/articles?per_page=100");
      const articles = listData.articles || [];
      const articleLines = articles.slice(0, 40).map((a, i) =>
        `[${i}] ID:${a.id} — "${a.title}" — Tags:${(a.tags||[]).join(",")} — ${(a.description||"").slice(0,120)}`
      ).join("\n");

      const prompt = `You are an IT knowledge base assistant for Renovation Brands. Find the most relevant articles for this query.

Query: "${query}"

Articles:
${articleLines}

Return ONLY a JSON array of the top 5 most relevant article IDs and why:
[{"id":<id>,"title":"<title>","relevance":<0-100>,"reason":"<1 sentence>"}]
Order by relevance descending. Only include relevance >= 30.`;

      const raw = await callClaude(prompt, { maxTokens: 500 });
      const results = parseJsonResponse(raw);
      const enriched = results.map(r => {
        const a = articles.find(x => x.id === r.id);
        return { ...r, updated_at: a?.updated_at, views: a?.views };
      });
      context.res = { body: { results: enriched, articles } };
    } catch(err) {
      context.log.error("KB search failed:", err.message);
      context.res = { status: 500, body: { error: err.message } };
    }
    return;
  }

  // ── Create article ────────────────────────────────────────────────────
  if (action === "create") {
    const { title, description, articleBody, folderId } = req.body || {};
    if (!title) { context.res = { status: 400, body: { error: "title required" } }; return; }
    try {
      // Get first available folder if none specified
      let folder = folderId;
      if (!folder) {
        const cats = await fsRequest("/solutions/categories").catch(() => ({ solution_categories: [] }));
        const firstCat = (cats.solution_categories || [])[0];
        if (firstCat) {
          const folders = await fsRequest(`/solutions/categories/${firstCat.id}/folders`).catch(() => ({ solution_folders: [] }));
          folder = (folders.solution_folders || [])[0]?.id;
        }
      }
      if (!folder) { context.res = { status: 400, body: { error: "No KB folder found — create one in Freshservice first" } }; return; }

      const payload = {
        title,
        description: description || "",
        article_type: 1, // permanent
        status: 2, // published
        folder_id: folder,
        tags: ["it-triage-cockpit"],
        ...(articleBody ? { description: articleBody } : {}),
      };
      const data = await fsRequest("/solutions/articles", { method: "POST", body: JSON.stringify({ article: payload }) });
      context.res = { body: { article: data.article, ok: true } };
    } catch(err) {
      context.log.error("KB create failed:", err.message);
      context.res = { status: 500, body: { error: err.message } };
    }
    return;
  }

  context.res = { status: 400, body: { error: `Unknown action: ${action}` } };
};
