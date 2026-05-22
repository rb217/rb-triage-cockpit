// api/settingsAutoReply/index.js
// GET  /api/settingsAutoReply         — fetch current settings
// POST /api/settingsAutoReply         — replace settings (body = new settings)
// Settings stored as a JSON blob in Key Vault secret AUTO-REPLY-SETTINGS.

const { app } = require("@azure/functions");
const {
  getPrincipal, isInItTeam,
  getSecret
} = require("../shared/clients");
const { DefaultAzureCredential } = require("@azure/identity");
const { SecretClient } = require("@azure/keyvault-secrets");

const SECRET_NAME = "AUTO-REPLY-SETTINGS";
const DEFAULT_SETTINGS = {
  globalEnabled: false,
  defaultThreshold: 85,
  categories: {
    // Each entry: { enabled: bool, threshold: number, requiresHumanReview?: bool }
    // Examples — all default off, you opt in one at a time
    "Software/Microsoft 365": { enabled: false, threshold: 85 },
    "Hardware/Peripherals": { enabled: false, threshold: 85 },
    "Network/VPN": { enabled: false, threshold: 90 }
  },
  blockedCategories: [
    // Always require human review for these — never auto-send
    "NetSuite",
    "Employee Onboarding/Offboarding",
    "Other"
  ],
  blockedKeywords: [
    "urgent", "asap", "emergency", "down", "outage",
    "fired", "terminated", "harassment", "legal", "lawsuit",
    "exec", "ceo", "cfo", "president"
  ]
};

function getKvClient() {
  const kvName = process.env.KEY_VAULT_NAME;
  const credential = new DefaultAzureCredential();
  return new SecretClient(`https://${kvName}.vault.azure.net`, credential);
}

async function getSettings() {
  try {
    const raw = await getSecret(SECRET_NAME);
    return JSON.parse(raw);
  } catch (e) {
    // Secret doesn't exist yet — return defaults
    return DEFAULT_SETTINGS;
  }
}

async function setSettings(settings) {
  const client = getKvClient();
  await client.setSecret(SECRET_NAME, JSON.stringify(settings));
}

app.http("settingsAutoReply", {
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    const principal = getPrincipal(request);
    if (!isInItTeam(principal)) {
      return { status: 403, jsonBody: { error: "Not authorized" } };
    }

    if (request.method === "GET") {
      try {
        const settings = await getSettings();
        return { jsonBody: settings };
      } catch (err) {
        return { status: 500, jsonBody: { error: err.message } };
      }
    }

    // POST — update
    let body;
    try { body = await request.json(); } catch { return { status: 400, jsonBody: { error: "Invalid JSON" } }; }

    // Basic validation
    if (typeof body.globalEnabled !== "boolean") body.globalEnabled = false;
    if (typeof body.defaultThreshold !== "number" || body.defaultThreshold < 60 || body.defaultThreshold > 100) {
      body.defaultThreshold = 85;
    }
    body.categories = body.categories || {};
    body.blockedCategories = body.blockedCategories || DEFAULT_SETTINGS.blockedCategories;
    body.blockedKeywords = body.blockedKeywords || DEFAULT_SETTINGS.blockedKeywords;
    body.lastModifiedBy = principal?.userDetails || "unknown";
    body.lastModifiedAt = new Date().toISOString();

    try {
      await setSettings(body);
      context.log(`Auto-reply settings updated by ${principal?.userDetails}`);
      return { jsonBody: body };
    } catch (err) {
      context.log.error("Settings save failed: " + err.message);
      return { status: 500, jsonBody: { error: err.message } };
    }
  }
});
