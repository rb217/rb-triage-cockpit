const { getPrincipal, isInItTeam } = require("../shared/clients");

// GET  /api/intune?action=user&email=...           — devices for a user
// GET  /api/intune?action=device&id=...            — full device detail + policies
// GET  /api/intune?action=devices                  — all managed devices + summary
// GET  /api/intune?action=noncompliant             — noncompliant devices
// GET  /api/intune?action=bitlocker&deviceId=...   — BitLocker recovery keys for a device
// GET  /api/intune?action=bitlocker&userId=...     — BitLocker recovery keys for a user
// POST /api/intune { action:"sync",    deviceId }  — MDM sync
// POST /api/intune { action:"retire",  deviceId }  — retire device
// POST /api/intune { action:"wipe",    deviceId }  — remote wipe

const GRAPH_V1   = "https://graph.microsoft.com/v1.0";
const GRAPH_BETA = "https://graph.microsoft.com/beta";

let _tokenCache = null, _tokenExpiry = 0;

async function getToken() {
  if (_tokenCache && Date.now() < _tokenExpiry - 60000) return _tokenCache;
  const { AAD_TENANT_ID: tid, AAD_GRAPH_CLIENT_ID: cid, AAD_CLIENT_SECRET: sec } = process.env;
  if (!tid || !cid || !sec) throw new Error("AAD credentials not configured");
  const res = await fetch(`https://login.microsoftonline.com/${tid}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: cid, client_secret: sec, scope: "https://graph.microsoft.com/.default" })
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Graph auth: ${data.error_description || data.error}`);
  _tokenCache = data.access_token;
  _tokenExpiry = Date.now() + data.expires_in * 1000;
  return _tokenCache;
}

async function gGet(path, beta = false) {
  const token = await getToken();
  const res = await fetch(`${beta ? GRAPH_BETA : GRAPH_V1}${path}`, {
    headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: "eventual" }
  });
  if (!res.ok) throw new Error(`Graph ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function gPost(path, body, beta = false) {
  const token = await getToken();
  const res = await fetch(`${beta ? GRAPH_BETA : GRAPH_V1}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(`Graph ${res.status}: ${(await res.text()).slice(0, 300)}`);
  if (res.status === 204 || res.headers.get("content-length") === "0") return { ok: true };
  const text = await res.text();
  return text ? JSON.parse(text) : { ok: true };
}

async function allPages(path, beta = false) {
  let results = [], url = path;
  while (url) {
    const data = await gGet(url, beta);
    results = results.concat(data.value || []);
    const next = data["@odata.nextLink"];
    url = next ? next.replace(beta ? GRAPH_BETA : GRAPH_V1, "") : null;
  }
  return results;
}

function summarize(devices) {
  const byOs = {}, byComp = { compliant:0, noncompliant:0, inGracePeriod:0, unknown:0, other:0 };
  let encrypted = 0, stale = 0;
  devices.forEach(d => {
    const os = d.operatingSystem || "Unknown";
    byOs[os] = (byOs[os] || 0) + 1;
    const c = d.complianceState || "other";
    byComp[c] !== undefined ? byComp[c]++ : byComp.other++;
    if (d.isEncrypted) encrypted++;
    const days = d.lastSyncDateTime ? Math.floor((Date.now() - new Date(d.lastSyncDateTime)) / 86400000) : 999;
    if (days >= 7) stale++;
  });
  const n = devices.length || 1;
  return {
    total: devices.length,
    byOs: Object.entries(byOs).sort((a,b)=>b[1]-a[1]).map(([os,count])=>({ os, count, pct: Math.round(count/n*100) })),
    byCompliance: byComp,
    encryptedPct: Math.round(encrypted/n*100),
    compliantPct: Math.round(byComp.compliant/n*100),
    staleCount: stale,
  };
}

const DEVICE_SELECT = "id,deviceName,userDisplayName,userPrincipalName,emailAddress,operatingSystem,osVersion,complianceState,lastSyncDateTime,isEncrypted,model,manufacturer,serialNumber,managementAgent,enrolledDateTime,totalStorageSpaceInBytes,freeStorageSpaceInBytes,azureADDeviceId";

module.exports = async function(context, req) {
  const principal = getPrincipal(req);
  if (!isInItTeam(principal)) { context.res = { status:403, body:{ error:"Not authorized" } }; return; }

  try {
    // ── POST: MDM actions ──────────────────────────────────────────────────
    if (req.method === "POST") {
      const { action, deviceId } = req.body || {};
      if (!deviceId) { context.res = { status:400, body:{ error:"deviceId required" } }; return; }
      const paths = {
        sync:   `/deviceManagement/managedDevices/${deviceId}/syncDevice`,
        retire: `/deviceManagement/managedDevices/${deviceId}/retire`,
        wipe:   `/deviceManagement/managedDevices/${deviceId}/wipe`,
      };
      if (!paths[action]) { context.res = { status:400, body:{ error:`Unknown action: ${action}` } }; return; }
      const body = action === "wipe" ? { keepEnrollmentData: false, keepUserData: false } : undefined;
      await gPost(paths[action], body);
      context.res = { body: { ok: true, message: `${action} command sent` } };
      return;
    }

    // ── GET actions ────────────────────────────────────────────────────────
    const { action, id, email, deviceId, userId } = req.query;

    // User devices (ticket context)
    if (action === "user" && email) {
      const devices = await allPages(
        `/deviceManagement/managedDevices?$filter=emailAddress eq '${encodeURIComponent(email)}'&$select=${DEVICE_SELECT}`
      ).catch(() => []);
      context.res = { body: { devices } };
      return;
    }

    // Single device detail + compliance policies
    if (action === "device" && id) {
      const [device, policies] = await Promise.allSettled([
        gGet(`/deviceManagement/managedDevices/${id}?$select=${DEVICE_SELECT},physicalMemoryInBytes,chassisType,joinType,azureADRegistered,azureADDeviceId`),
        gGet(`/deviceManagement/managedDevices/${id}/deviceCompliancePolicyStates?$top=20`)
      ]);
      const d = device.status === "fulfilled" ? device.value : null;
      const policyStates = policies.status === "fulfilled" ? (policies.value.value || []) : [];
      const failingPolicies = policyStates.filter(p => p.state !== "compliant" && p.state !== "notApplicable");
      context.res = { body: { device: d, policyStates, failingPolicies } };
      return;
    }

    // All devices + summary
    if (action === "devices") {
      const devices = await allPages(`/deviceManagement/managedDevices?$select=${DEVICE_SELECT}&$top=100`);
      devices.sort((a,b) => {
        const score = d => d.complianceState==="noncompliant"?3:d.complianceState==="inGracePeriod"?2:0;
        return score(b) - score(a);
      });
      context.res = { body: { summary: summarize(devices), devices } };
      return;
    }

    // Non-compliant devices
    if (action === "noncompliant") {
      const devices = await allPages(
        `/deviceManagement/managedDevices?$filter=complianceState eq 'noncompliant'&$select=${DEVICE_SELECT}&$top=50`
      );
      context.res = { body: { devices } };
      return;
    }

    // ── BitLocker recovery keys ────────────────────────────────────────────
    if (action === "bitlocker") {
      // List keys — filter by deviceId or userId
      let filter = "";
      if (deviceId) filter = `?$filter=deviceId eq '${deviceId}'`;
      else if (userId) filter = `?$filter=volumeType eq 'operatingSystemVolume' and deviceId in (` +
        // First get device IDs for this user
        `'placeholder')`; // handled below with two-step

      let keyMeta;
      if (deviceId) {
        // Get key metadata for a specific device
        keyMeta = await gGet(`/informationProtection/bitlocker/recoveryKeys?$filter=deviceId eq '${deviceId}'`, true)
          .catch(() => ({ value: [] }));
      } else if (userId) {
        // Get user's managed devices, then query their keys
        const userDevices = await allPages(
          `/deviceManagement/managedDevices?$filter=userId eq '${userId}'&$select=id,deviceName,azureADDeviceId&$top=20`
        ).catch(() => []);
        const azureIds = userDevices.map(d => d.azureADDeviceId).filter(Boolean);
        if (!azureIds.length) {
          context.res = { body: { keys: [], message: "No Azure AD device IDs found for user" } };
          return;
        }
        // Query keys for each device
        const keyResults = await Promise.allSettled(
          azureIds.slice(0,5).map(aid =>
            gGet(`/informationProtection/bitlocker/recoveryKeys?$filter=deviceId eq '${aid}'`, true)
          )
        );
        const allKeys = keyResults.flatMap(r => r.status === "fulfilled" ? (r.value.value || []) : []);
        context.res = { body: { keys: allKeys, devices: userDevices } };
        return;
      } else {
        context.res = { status: 400, body: { error: "deviceId or userId required for bitlocker action" } };
        return;
      }

      const keys = keyMeta.value || [];
      context.res = { body: { keys } };
      return;
    }

    // ── Retrieve actual BitLocker key value ───────────────────────────────
    if (action === "bitlockerkey" && id) {
      // Requires BitLockerKey.Read.All permission (more sensitive than ReadBasic)
      const keyDetail = await gGet(`/informationProtection/bitlocker/recoveryKeys/${id}?$select=key`, true);
      context.res = { body: { key: keyDetail.key, id } };
      return;
    }

    context.res = { status: 400, body: { error: "Unknown action" } };

  } catch(err) {
    context.log.error("intune failed:", err);
    context.res = { status: 500, body: { error: err.message } };
  }
};
