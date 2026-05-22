// api/shared/clients.js
// Shared helpers: Key Vault access, Freshservice API, Claude API.
// All Functions use these so secrets stay out of every file.

const { DefaultAzureCredential } = require("@azure/identity");
const { SecretClient } = require("@azure/keyvault-secrets");

const KV_NAME = process.env.KEY_VAULT_NAME;
const FS_DOMAIN = process.env.FRESHSERVICE_DOMAIN;

// Cache secrets for the lifetime of the Function instance
// (warm starts reuse this; cold starts refetch)
let _kvClient = null;
const _secretCache = new Map();

function getKvClient() {
  if (!_kvClient) {
    const credential = new DefaultAzureCredential();
    _kvClient = new SecretClient(`https://${KV_NAME}.vault.azure.net`, credential);
  }
  return _kvClient;
}

async function getSecret(name) {
  if (_secretCache.has(name)) return _secretCache.get(name);
  const client = getKvClient();
  const secret = await client.getSecret(name);
  _secretCache.set(name, secret.value);
  return secret.value;
}

// ============================================================
// Auth: parse SWA's x-ms-client-principal header
// ============================================================
function getPrincipal(request) {
  const header = request.headers.get("x-ms-client-principal");
  if (!header) return null;
  try {
    const decoded = Buffer.from(header, "base64").toString("utf-8");
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function isInItTeam(principal) {
  if (!principal) return false;
  const roles = principal.userRoles || [];
  return roles.includes("it-team");
}

// ============================================================
// Freshservice API
// ============================================================
async function fsRequest(path, options = {}) {
  const apiKey = await getSecret(process.env.FRESHSERVICE_API_KEY_SETTING || "FRESHSERVICE-API-KEY");
  const auth = Buffer.from(`${apiKey}:X`).toString("base64");
  const url = `https://${FS_DOMAIN}/api/v2${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Freshservice ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function fsGetTickets({ filter = "new_and_my_open", page = 1, perPage = 100, includeStats = true } = {}) {
  const include = includeStats ? "&include=stats" : "";
  // Freshservice filter values: new_and_my_open, watching, spam, deleted
  // For all open: use ?filter=new_and_my_open or query by query params
  const data = await fsRequest(`/tickets?filter=${filter}&per_page=${perPage}&page=${page}${include}`);
  return data.tickets || [];
}

async function fsGetAllOpenTickets() {
  // Pull all open + pending + hold tickets across the group
  // Freshservice statuses: 2=open, 3=pending, 6=hold
  const queries = [];
  for (const status of [2, 3, 6]) {
    queries.push(`status:${status}`);
  }
  const q = encodeURIComponent(`"${queries.join(" OR ")}"`);
  const data = await fsRequest(`/tickets/filter?query=${q}&per_page=100`);
  return data.tickets || [];
}

async function fsGetTicket(id) {
  const data = await fsRequest(`/tickets/${id}?include=requester,stats`);
  return data.ticket;
}

async function fsUpdateTicket(id, fields) {
  // fields: {status, priority, responder_id, category, sub_category, ...}
  return fsRequest(`/tickets/${id}`, {
    method: "PUT",
    body: JSON.stringify(fields)
  });
}

async function fsAddNote(id, body, isPrivate = false) {
  return fsRequest(`/tickets/${id}/notes`, {
    method: "POST",
    body: JSON.stringify({ body, private: isPrivate })
  });
}

async function fsReplyToTicket(id, body) {
  // Sends a public reply to the requester
  return fsRequest(`/tickets/${id}/reply`, {
    method: "POST",
    body: JSON.stringify({ body })
  });
}

async function fsGetClosedTickets(limit = 200) {
  // Last N closed/resolved tickets — used for "similar past tickets" matching
  const q = encodeURIComponent(`"status:4 OR status:5"`);
  const data = await fsRequest(`/tickets/filter?query=${q}&per_page=${Math.min(limit, 100)}`);
  return (data.tickets || []).slice(0, limit);
}

async function fsGetAgents() {
  const data = await fsRequest(`/agents?per_page=100`);
  return data.agents || [];
}

async function fsGetRequester(id) {
  const data = await fsRequest(`/requesters/${id}`);
  return data.requester;
}

// Lookup an agent by name (case-insensitive). Returns id or null.
async function fsFindAgentByName(name) {
  if (!name) return null;
  const agents = await fsGetAgentMap();
  const lname = name.toLowerCase().trim();
  for (const a of Object.values(agents)) {
    if (a.name.toLowerCase() === lname) return a.id;
    if (a.email && a.email.toLowerCase() === lname) return a.id;
  }
  return null;
}

// Cache agent lookup since it rarely changes
let _agentsCache = null;
let _agentsCacheTime = 0;
async function fsGetAgentMap() {
  const now = Date.now();
  if (_agentsCache && (now - _agentsCacheTime) < 5 * 60 * 1000) return _agentsCache;
  const agents = await fsGetAgents();
  const map = {};
  for (const a of agents) {
    map[a.id] = {
      id: a.id,
      name: `${a.first_name || ""} ${a.last_name || ""}`.trim() || a.email,
      email: a.email
    };
  }
  _agentsCache = map;
  _agentsCacheTime = now;
  return map;
}

// ============================================================
// Claude API
// ============================================================
async function callClaude(prompt, { maxTokens = 1000, model = "claude-sonnet-4-20250514" } = {}) {
  const apiKey = await getSecret(process.env.ANTHROPIC_API_KEY_SETTING || "ANTHROPIC-API-KEY");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }]
    })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Claude ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.content.filter(c => c.type === "text").map(c => c.text).join("").trim();
}

function parseJsonResponse(text) {
  const clean = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
  return JSON.parse(clean);
}

// ============================================================
// Teams webhook (for scheduled pattern detection)
// ============================================================
async function postTeamsCard(card) {
  const url = await getSecret(process.env.TEAMS_WEBHOOK_URL_SETTING || "TEAMS-WEBHOOK-URL");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(card)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Teams webhook ${res.status}: ${text.slice(0, 300)}`);
  }
  return true;
}

module.exports = {
  getSecret,
  getPrincipal,
  isInItTeam,
  fsGetAllOpenTickets,
  fsGetTicket,
  fsUpdateTicket,
  fsAddNote,
  fsGetClosedTickets,
  fsGetAgentMap,
  fsGetRequester,
  fsFindAgentByName,
  fsReplyToTicket,
  callClaude,
  parseJsonResponse,
  postTeamsCard
};
