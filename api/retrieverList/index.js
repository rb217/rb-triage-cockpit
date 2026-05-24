const { getPrincipal, isInItTeam } = require("../shared/clients");

async function retrieverFetch(path) {
  const apiKey = process.env.RETRIEVER_API_KEY;
  if (!apiKey) throw new Error("RETRIEVER_API_KEY not configured");
  const res = await fetch(`https://app.helloretriever.com/api/v2${path}`, {
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Retriever ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

module.exports = async function(context, req) {
  const principal = getPrincipal(req);
  if (!isInItTeam(principal)) { context.res = { status: 403, body: { error: "Not authorized" } }; return; }
  const type = req.query.type || "all";
  try {
    let data = {};
    if (type === "all" || type === "warehouse") {
      try { data.warehouse = await retrieverFetch("/warehouse/"); } catch(e) { data.warehouse = { error: e.message }; }
    }
    if (type === "all" || type === "returns") {
      try { data.returns = await retrieverFetch("/device_returns/"); } catch(e) { data.returns = { error: e.message }; }
    }
    if (type === "all" || type === "deployments") {
      try { data.deployments = await retrieverFetch("/deployments/"); } catch(e) { data.deployments = { error: e.message }; }
    }
    if (type === "all" || type === "balances") {
      try { data.balances = await retrieverFetch("/prepaid_balances/"); } catch(e) { data.balances = { error: e.message }; }
    }
    context.res = { body: data };
  } catch(err) {
    context.log.error("retrieverList failed", err);
    context.res = { status: 500, body: { error: err.message } };
  }
};
