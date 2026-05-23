const { getPrincipal, isInItTeam, getSecret } = require("../shared/clients");
const { DefaultAzureCredential } = require("@azure/identity");
const { SecretClient } = require("@azure/keyvault-secrets");
const DEFAULT = { globalEnabled:false, defaultThreshold:85, categories:{}, blockedCategories:["NetSuite","Employee Onboarding/Offboarding","Other"], blockedKeywords:["urgent","asap","emergency","down","outage","fired","terminated","exec","ceo"] };
module.exports = async function(context, req) {
  const principal = getPrincipal(req);
  if (!isInItTeam(principal)) { context.res = { status: 403, body: { error: "Not authorized" } }; return; }
  const kvName = process.env.KEY_VAULT_NAME;
  const client = new SecretClient(`https://${kvName}.vault.azure.net`, new DefaultAzureCredential());
  if (req.method === "GET") {
    try { const s = await client.getSecret("AUTO-REPLY-SETTINGS"); context.res = { body: JSON.parse(s.value) }; }
    catch(e) { context.res = { body: DEFAULT }; }
    return;
  }
  const s = { ...req.body, lastModifiedBy: principal?.userDetails, lastModifiedAt: new Date().toISOString() };
  try { await client.setSecret("AUTO-REPLY-SETTINGS", JSON.stringify(s)); context.res = { body: s }; }
  catch(err) { context.res = { status: 500, body: { error: err.message } }; }
};
