const { getPrincipal, isInItTeam } = require("../shared/clients");
const { getFullUserContext } = require("../shared/graph");
const _cache = new Map();
const TTL = 5 * 60 * 1000;
module.exports = async function(context, req) {
  const principal = getPrincipal(req);
  if (!isInItTeam(principal)) { context.res = { status: 403, body: { error: "Not authorized" } }; return; }
  const email = req.query.email;
  if (!email) { context.res = { status: 400, body: { error: "email required" } }; return; }
  const cached = _cache.get(email.toLowerCase());
  if (cached && (Date.now() - cached.t) < TTL) { context.res = { body: { ...cached.data, fromCache: true } }; return; }
  try {
    const data = await getFullUserContext(email);
    _cache.set(email.toLowerCase(), { t: Date.now(), data });
    context.res = { body: data };
  } catch(err) {
    context.log.error("m365Context failed", err);
    context.res = { body: { found: false, error: err.message } };
  }
};
