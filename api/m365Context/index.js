// api/m365Context/index.js
// GET /api/m365Context?email=<user>
// Returns consolidated M365/Entra ID context for a ticket requester.

const { app } = require("@azure/functions");
const { getPrincipal, isInItTeam } = require("../shared/clients");
const { getFullUserContext } = require("../shared/graph");

// Simple in-memory cache (per Function instance) — context doesn't change minute-to-minute
const _cache = new Map();
const TTL_MS = 5 * 60 * 1000; // 5 minutes

app.http("m365Context", {
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    const principal = getPrincipal(request);
    if (!isInItTeam(principal)) {
      return { status: 403, jsonBody: { error: "Not authorized" } };
    }

    const email = new URL(request.url).searchParams.get("email");
    if (!email) {
      return { status: 400, jsonBody: { error: "email parameter required" } };
    }

    // Cache check
    const cached = _cache.get(email.toLowerCase());
    if (cached && (Date.now() - cached.t) < TTL_MS) {
      return { jsonBody: { ...cached.data, fromCache: true } };
    }

    try {
      const data = await getFullUserContext(email);
      _cache.set(email.toLowerCase(), { t: Date.now(), data });
      return { jsonBody: data };
    } catch (err) {
      context.log.error("m365Context failed for " + email, err);
      // Don't fail the whole dashboard if Graph is having issues — return empty context
      return {
        status: 200,
        jsonBody: { found: false, error: err.message }
      };
    }
  }
});
