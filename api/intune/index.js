const { getPrincipal, isInItTeam } = require("../shared/clients");

// GET  /api/intune?action=user&email=...        — devices for a user (ticket context)
// GET  /api/intune?action=device&id=...         — full device detail + compliance policies
// GET  /api/intune?action=devices               — all managed devices
// GET  /api/intune?action=noncompliant          — noncompliant devices (proactive IT)
// POST /api/intune { action:"sync",   deviceId } — trigger MDM sync
// POST /api/intune { action:"retire", deviceId } — retire device
// POST /api/intune { action:"wipe",   deviceId } — remote wipe

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const GRAPH_BETA = "https://graph.microsoft.com/beta";

let _tokenCache = null, _tokenExpiry = 0;

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

async function graphPost(path, body, beta = false) {
  const token = await getGraphToken();
  const base = beta ? GRAPH_BETA : GRAPH_BASE;
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(`Graph ${res.status}: ${(await res.text()).slice(0, 200)}`);
  // 204 No Content is success for MDM actions — don't try to parse empty body
  if (res.status === 204 || res.headers.get("content-length") === "0") return { ok: true };
  const text = await res.text();
  if (!text || !text.trim()) return { ok: true };
  try { return JSON.parse(text); } catch(e) { return { ok: true }; }
}

async function getAllPages(path, beta = false) {
  let results = [], url = path;
  while (url) {
    const data = await graphGet(url, beta);
    results = results.concat(data.value || []);
    url = data["@odata.nextLink"]?.replace(beta ? GRAPH_BETA : GRAPH_BASE, "") || null;
  }
  return results;
}

function buildDeviceSummary(devices) {
  const total = devices.length;
  const byOs = {}, byCompliance = { compliant: 0, noncompliant: 0, inGracePeriod: 0, unknown: 0, other: 0 };
  let encryptedCount = 0, staleCount = 0;
  devices.forEach(d => {
    const os = d.operatingSystem || "Unknown";
    byOs[os] = (byOs[os] || 0) + 1;
    const c = d.complianceState || "other";
    if (byCompliance[c] !== undefined) byCompliance[c]++; else byCompliance.other++;
    if (d.isEncrypted) encryptedCount++;
    const days = d.lastSyncDateTime ? Math.floor((Date.now() - new Date(d.lastSyncDateTime)) / 86400000) : 999;
    if (days >= 7) staleCount++;
  });
  return {
    total,
    byOs: Object.entries(byOs).sort((a,b)=>b[1]-a[1]).map(([os,count])=>({os,count,pct:Math.round(count/total*100)})),
    byCompliance,
    encryptedPct: total ? Math.round(encryptedCount/total*100) : 0,
    staleCount,
    compliantPct: total ? Math.round(byCompliance.compliant/total*100) : 0
  };
}

module.exports = async function(context, req) {
  const principal = getPrincipal(req);
  if (!isInItTeam(principal)) { context.res = { status: 403, body: { error: "Not authorized" } }; return; }

  try {
    if (req.method === "POST") {
      const { action, deviceId } = req.body || {};
      if (!deviceId) { context.res = { status: 400, body: { error: "deviceId required" } }; return; }

      switch(action) {
        case "sync":
          await graphPost(`/deviceManagement/managedDevices/${deviceId}/syncDevice`);
          context.res = { body: { ok: true, message: "Sync command sent" } };
          break;
        case "retire":
          await graphPost(`/deviceManagement/managedDevices/${deviceId}/retire`);
          context.res = { body: { ok: true, message: "Device retired" } };
          break;
        case "wipe":
          await graphPost(`/deviceManagement/managedDevices/${deviceId}/wipe`, { keepEnrollmentData: false, keepUserData: false });
          context.res = { body: { ok: true, message: "Wipe command sent" } };
          break;
        default:
          context.res = { status: 400, body: { error: `Unknown action: ${action}` } };
      }
      return;
    }

    const { action, id, email } = req.query;

    if (action === "user" && email) {
      const devices = await getAllPages(
        `/deviceManagement/managedDevices?$filter=emailAddress eq '${email}'&$select=id,deviceName,operatingSystem,osVersion,complianceState,lastSyncDateTime,isEncrypted,model,manufacturer,serialNumber,userPrincipalName,managementAgent`
      ).catch(() => []);
      context.res = { body: { devices } };

    } else if (action === "device" && id) {
      const [device, configs] = await Promise.allSettled([
        graphGet(`/deviceManagement/managedDevices/${id}?$select=id,deviceName,operatingSystem,osVersion,complianceState,lastSyncDateTime,isEncrypted,model,manufacturer,serialNumber,userDisplayName,userPrincipalName,emailAddress,managementAgent,enrolledDateTime,physicalMemoryInBytes,totalStorageSpaceInBytes,freeStorageSpaceInBytes,chassisType,joinType`),
        graphGet(`/deviceManagement/managedDevices/${id}/deviceCompliancePolicyStates?$top=20`)
      ]);
      const deviceData = device.status === "fulfilled" ? device.value : null;
      const policyStates = configs.status === "fulfilled" ? (configs.value.value || []) : [];
      // Identify failing policies
      const failingPolicies = policyStates.filter(p => p.state !== "compliant" && p.state !== "notApplicable");
      context.res = { body: { device: deviceData, policyStates, failingPolicies } };

    } else if (action === "devices") {
      const devices = await getAllPages(
        "/deviceManagement/managedDevices?$select=id,deviceName,userDisplayName,userPrincipalName,operatingSystem,osVersion,complianceState,lastSyncDateTime,isEncrypted,managementAgent,model,manufacturer,serialNumber,emailAddress&$top=100"
      );
      devices.sort((a, b) => {
        const scoreA = (a.complianceState === "noncompliant" ? 3 : a.complianceState === "inGracePeriod" ? 2 : 0);
        const scoreB = (b.complianceState === "noncompliant" ? 3 : b.complianceState === "inGracePeriod" ? 2 : 0);
        return scoreB - scoreA;
      });
      context.res = { body: { summary: buildDeviceSummary(devices), devices } };

    } else if (action === "noncompliant") {
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
