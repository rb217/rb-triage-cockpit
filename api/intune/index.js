const { getPrincipal, isInItTeam } = require("../shared/clients");

// GET /api/intune?action=devices              — all managed devices
// GET /api/intune?action=device&id=...        — single device detail
// GET /api/intune?action=compliance           — compliance summary
// GET /api/intune?action=user&email=...       — devices for a user

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const GRAPH_BETA = "https://graph.microsoft.com/beta";

let _tokenCache = null;
let _tokenExpiry = 0;

async function getGraphToken() {
  if (_tokenCache && Date.now() < _tokenExpiry - 60000) return _tokenCache;
  const tenantId = process.env.AAD_TENANT_ID;
  const clientId = process.env.AAD_GRAPH_CLIENT_ID;
  const clientSecret = process.env.AAD_CLIENT_SECRET;
  if (!tenantId || !clientId || !clientSecret) throw new Error("AAD credentials not configured");
  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret, scope: "https://graph.microsoft.com/.default" })
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Graph auth failed: ${data.error_description || data.error}`);
  _tokenCache = data.access_token;
  _tokenExpiry = Date.now() + (data.expires_in * 1000);
  return _tokenCache;
}

async function graphGet(path, beta = false) {
  const token = await getGraphToken();
  const base = beta ? GRAPH_BETA : GRAPH_BASE;
  const res = await fetch(`${base}${path}`, {
    headers: { "Authorization": `Bearer ${token}`, "ConsistencyLevel": "eventual" }
  });
  if (!res.ok) throw new Error(`Graph ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function getAllPages(path, beta = false) {
  let results = [];
  let url = path;
  while (url) {
    const data = await graphGet(url, beta);
    results = results.concat(data.value || []);
    url = data["@odata.nextLink"]?.replace(beta ? GRAPH_BETA : GRAPH_BASE, "") || null;
  }
  return results;
}

function getComplianceColor(state) {
  switch(state) {
    case "compliant": return "ok";
    case "noncompliant": return "danger";
    case "inGracePeriod": return "warn";
    case "unknown": return "ghost";
    default: return "dim";
  }
}

function buildDeviceSummary(devices) {
  const total = devices.length;
  const byOs = {};
  const byCompliance = { compliant: 0, noncompliant: 0, inGracePeriod: 0, unknown: 0, other: 0 };
  let encryptedCount = 0;
  let staleCount = 0;

  devices.forEach(d => {
    const os = d.operatingSystem || "Unknown";
    byOs[os] = (byOs[os] || 0) + 1;
    const c = d.complianceState || "other";
    if (byCompliance[c] !== undefined) byCompliance[c]++;
    else byCompliance.other++;
    if (d.isEncrypted) encryptedCount++;
    const days = d.lastSyncDateTime ? Math.floor((Date.now() - new Date(d.lastSyncDateTime)) / 86400000) : 999;
    if (days >= 7) staleCount++;
  });

  return {
    total,
    byOs: Object.entries(byOs).sort((a,b)=>b[1]-a[1]).map(([os,count])=>({os,count,pct:Math.round(count/total*100)})),
    byCompliance,
    encryptedPct: total ? Math.round(encryptedCount/total*100) : 0,
    stalePct: total ? Math.round(staleCount/total*100) : 0,
    staleCount,
    compliantPct: total ? Math.round(byCompliance.compliant/total*100) : 0
  };
}

module.exports = async function(context, req) {
  const principal = getPrincipal(req);
  if (!isInItTeam(principal)) {
    context.res = { status: 403, body: { error: "Not authorized" } };
    return;
  }

  try {
    const { action, id, email } = req.query;

    if (action === "devices" || action === "compliance") {
      const devices = await getAllPages(
        "/deviceManagement/managedDevices?$select=id,deviceName,userDisplayName,userPrincipalName,operatingSystem,osVersion,complianceState,lastSyncDateTime,isEncrypted,managementAgent,deviceEnrollmentType,model,manufacturer,serialNumber,emailAddress&$top=100"
      );
      const summary = buildDeviceSummary(devices);

      if (action === "compliance") {
        context.res = { body: { summary } };
        return;
      }

      // Sort: noncompliant first, then stale, then compliant
      devices.sort((a, b) => {
        const scoreA = (a.complianceState === "noncompliant" ? 3 : a.complianceState === "inGracePeriod" ? 2 : 0);
        const scoreB = (b.complianceState === "noncompliant" ? 3 : b.complianceState === "inGracePeriod" ? 2 : 0);
        return scoreB - scoreA;
      });

      context.res = { body: { summary, devices } };

    } else if (action === "device" && id) {
      const [device, configs] = await Promise.allSettled([
        graphGet(`/deviceManagement/managedDevices/${id}`),
        graphGet(`/deviceManagement/managedDevices/${id}/deviceConfigurationStates?$top=20`)
      ]);
      context.res = { body: {
        device: device.status === "fulfilled" ? device.value : null,
        configStates: configs.status === "fulfilled" ? (configs.value.value || []) : []
      }};

    } else if (action === "user" && email) {
      const devices = await getAllPages(
        `/deviceManagement/managedDevices?$filter=emailAddress eq '${email}'&$select=id,deviceName,operatingSystem,osVersion,complianceState,lastSyncDateTime,isEncrypted,model,manufacturer,serialNumber`
      ).catch(() => []);
      context.res = { body: { devices } };

    } else if (action === "noncompliant") {
      // For proactive IT
      const devices = await getAllPages(
        "/deviceManagement/managedDevices?$filter=complianceState eq 'noncompliant'&$select=id,deviceName,userDisplayName,userPrincipalName,operatingSystem,osVersion,lastSyncDateTime,emailAddress&$top=50"
      );
      context.res = { body: { devices } };

    } else {
      context.res = { status: 400, body: { error: "Unknown action" } };
    }
  } catch(err) {
    context.log.error("intune failed", err);
    context.res = { status: 500, body: { error: err.message } };
  }
};
