const { getPrincipal, isInItTeam, fsRequest, callClaude, parseJsonResponse } = require("../shared/clients");

// GET  /api/knowledgeBase?action=search&q=...&category=...
// GET  /api/knowledgeBase?action=list&page=1
// GET  /api/knowledgeBase?action=folders
// POST /api/knowledgeBase  { action:"extract", ticketId, title, description, resolution }
// POST /api/knowledgeBase  { action:"create", title, description, article_type, folder_id, tags }

const DEFAULT_FOLDER_NAME = "IT Triage Cockpit — Auto KB";

async function getFolders() {
  const data = await fsRequest("/solutions/categories");
  const cats = data.categories || [];
  const results = [];
  for (const cat of cats) {
    const fd = await fsRequest(`/solutions/categories/${cat.id}/folders`);
    for (const f of fd.folders || []) results.push({ id: f.id, name: f.name, category: cat.name });
  }
  return results;
}

async function getOrCreateFolder() {
  const folders = await getFolders();
  const existing = folders.find(f => f.name === DEFAULT_FOLDER_NAME);
  if (existing) return existing.id;
  // find or create a category first
  const cats = await fsRequest("/solutions/categories");
  let catId = cats.categories?.[0]?.id;
  if (!catId) {
    const nc = await fsRequest("/solutions/categories", { method: "POST", body: JSON.stringify({ name: "IT Knowledge Base" }) });
    catId = nc.category?.id;
  }
  const nf = await fsRequest(`/solutions/categories/${catId}/folders`, {
    method: "POST",
    body: JSON.stringify({ name: DEFAULT_FOLDER_NAME, visibility: 2 }) // 2 = agents only
  });
  return nf.folder?.id;
}

async function searchArticles(q, category) {
  const params = [`per_page=30`];
  if (category) params.push(`category_name=${encodeURIComponent(category)}`);
  const data = await fsRequest(`/solutions/articles/search?term=${encodeURIComponent(q)}&${params.join("&")}`);
  return data.articles || [];
}

async function listArticles(page = 1) {
  const folders = await getFolders();
  const target = folders.find(f => f.name === DEFAULT_FOLDER_NAME);
  if (!target) return [];
  const data = await fsRequest(`/solutions/folders/${target.id}/articles?per_page=30&page=${page}`);
  return data.articles || [];
}

async function extractResolution(ticket, notes) {
  const prompt = `You are an IT knowledge base builder. Analyze this resolved Freshservice ticket and extract a KB article. Return ONLY JSON.

TICKET #${ticket.id}: ${ticket.subject}
Category: ${ticket.category || "—"} / ${ticket.sub_category || "—"}
Description: ${(ticket.description_text || "").slice(0, 500)}
Resolution notes: ${(notes || "").slice(0, 500)}

Return:
{
  "title": "<concise problem title, 5-10 words>",
  "problem_summary": "<2-3 sentences describing the problem>",
  "root_cause": "<1-2 sentences on why it happened>",
  "resolution_steps": ["<step 1>", "<step 2>", "<step 3>"],
  "tags": ["<tag1>", "<tag2>", "<tag3>"],
  "article_type": 1,
  "deflectable": <true|false>,
  "deflection_hint": "<if deflectable, what self-service action could have avoided this>"
}`;
  return parseJsonResponse(await callClaude(prompt, { maxTokens: 1000 }));
}

module.exports = async function(context, req) {
  const principal = getPrincipal(req);
  if (!isInItTeam(principal)) { context.res = { status: 403, body: { error: "Not authorized" } }; return; }

  try {
    if (req.method === "GET") {
      const { action, q, category, page } = req.query;
      if (action === "search" && q) {
        const articles = await searchArticles(q, category);
        context.res = { body: { articles } };
      } else if (action === "folders") {
        const folders = await getFolders();
        context.res = { body: { folders } };
      } else {
        const articles = await listArticles(parseInt(page) || 1);
        context.res = { body: { articles } };
      }
    } else {
      const { action, ticketId, title, description, resolution, folder_id, tags, article_type } = req.body || {};

      if (action === "extract") {
        if (!ticketId) { context.res = { status: 400, body: { error: "ticketId required" } }; return; }
        const ticketData = await fsRequest(`/tickets/${ticketId}?include=requester,stats`);
        const ticket = ticketData.ticket;
        const notesData = await fsRequest(`/tickets/${ticketId}/notes`);
        const notes = (notesData.notes || []).map(n => n.body_text || n.body || "").join("\n");
        const extracted = await extractResolution(ticket, notes);
        context.res = { body: { extracted, ticketId } };

      } else if (action === "create") {
        const folderId = folder_id || await getOrCreateFolder();
        const article = await fsRequest(`/solutions/folders/${folderId}/articles`, {
          method: "POST",
          body: JSON.stringify({
            title: title || "Untitled",
            description: description || "",
            article_type: article_type || 1,
            status: 1, // draft — agent reviews before publishing
            tags: tags || []
          })
        });
        context.res = { status: 201, body: { article: article.article } };

      } else {
        context.res = { status: 400, body: { error: "Unknown action" } };
      }
    }
  } catch(err) {
    context.log.error("knowledgeBase failed", err);
    context.res = { status: 500, body: { error: err.message } };
  }
};
