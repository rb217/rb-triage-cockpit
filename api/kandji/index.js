const { getPrincipal, isInItTeam } = require("../shared/clients");

// GET /api/kandji?action=fleet                    — all devices + compliance summary
// GET /api/kandji?action=device&email=...         — device by user email
// GET /api/kandji?action=device&serial=...        — device by serial number
// GET /api/kandji?action=vulnerabilities          — CVE exposure across fleet
// POST /api/kandji { action:"lock",   deviceId, pin }
// POST /api/kandji { action:"wipe",   deviceId }
// POST /api/kandji { action:"checkin", deviceId }
// POST /api/kandji { action:"restart", deviceId }

const KANDJI_BASE = () => {
  const sub = process.env.KANDJI_SUBDOMAIN;
  if (!sub) throw new Error("KANDJI_SUBDOMAIN not configured");
  return `https://${sub}.api.kandji.io/api/v1`;
};

let _deviceCache = null;
let _deviceCacheTime = 0;
const CACHE_TTL = 3 * 60 * 1000;

async function kandjiGet(path) {
  const key = process.env.KANDJI_API_KEY;
  if (!key) throw new Error("KANDJI_API_KEY not configured");
  const res = await fetch(`${KANDJI_BASE()}${path}`, {
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }
  });
  if (res.status === 429) throw new Error("Kandji rate limit — try again shortly");
  if (!res.ok) throw new Error(`Kandji ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function kandjiPost(path, body) {
  const key = process.env.KANDJI_API_KEY;
  if (!key) throw new Error("KANDJI_API_KEY not configured");
  const res = await fetch(`${KANDJI_BASE()}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(`Kandji ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? { ok: true } : res.json().catch(() => ({ ok: true }));
}

async function getAllDevices() {
  if (_deviceCache && Date.now() - _deviceCacheTime < CACHE_TTL) return _deviceCache;
  const data = await kandjiGet("/devices?limit=300");
  _deviceCache = data.results || data || [];
  _deviceCacheTime = Date.now();
  return _deviceCache;
}

async function getDeviceDetails(deviceId) {
  const [detail, apps, activity] = await Promise.allSettled([
    kandjiGet(`/devices/${deviceId}/details`),
    kandjiGet(`/devices/${deviceId}/apps`),
    kandjiGet(`/devices/${deviceId}/activity?limit=10`)
  ]);
  return {
    detail: detail.status === "fulfilled" ? detail.value : null,
    apps: apps.status === "fulfilled" ? (apps.value.app_list || apps.value || []) : [],
    activity: activity.status === "fulfilled" ? (activity.value.results || activity.value || []) : []
  };
}

function computeCompliance(device) {
  const issues = [];
  if (!device.filevault_enabled) issues.push("FileVault disabled");
  if (device.is_missing) issues.push("Device missing/offline");
  if (!device.passcode_present) issues.push("No passcode");
  const daysSinceCheckIn = device.last_check_in
    ? Math.floor((Date.now() - new Date(device.last_check_in)) / 86400000)
    : null;
  if (daysSinceCheckIn !== null && daysSinceCheckIn > 7) issues.push(`Not checked in for ${daysSinceCheckIn} days`);
  return { compliant: issues.length === 0, issues, daysSinceCheckIn };
}

function buildFleetSummary(devices) {
  const total = devices.length;
  const osVersions = {};
  let filevaultOk = 0, sipOk = 0, checkedInRecently = 0, missingCount = 0;

  devices.forEach(d => {
    const v = d.os_version || "Unknown";
    osVersions[v] = (osVersions[v] || 0) + 1;
    if (d.filevault_enabled) filevaultOk++;
    if (!d.is_missing) sipOk++;
    const days = d.last_check_in ? Math.floor((Date.now() - new Date(d.last_check_in)) / 86400000) : 999;
    if (days <= 7) checkedInRecently++;
    if (d.is_missing) missingCount++;
  });

  // Sort OS versions
  const sortedOs = Object.entries(osVersions)
    .sort((a, b) => b[1] - a[1])
    .map(([version, count]) => ({ version, count, pct: Math.round((count / total) * 100) }));

  return {
    total,
    filevaultPct: total ? Math.round((filevaultOk / total) * 100) : 0,
    checkedInPct: total ? Math.round((checkedInRecently / total) * 100) : 0,
    missingCount,
    osVersions: sortedOs.slice(0, 6)
  };
}

module.exports = async function(context, req) {
  const principal = getPrincipal(req);
  if (!isInItTeam(principal)) {
    context.res = { status: 403, body: { error: "Not authorized" } };
    return;
  }

  try {
    if (req.method === "GET") {
      const { action, email, serial } = req.query;

      if (action === "fleet") {
        const devices = await getAllDevices();
        const summary = buildFleetSummary(devices);
        const enriched = devices.map(d => ({ ...d, _compliance: computeCompliance(d) }));
        // Sort: missing/offline first, then non-compliant, then compliant
        enriched.sort((a, b) => {
          const aScore = (a.is_missing ? 3 : 0) + (a._compliance.issues.length > 0 ? 1 : 0);
          const bScore = (b.is_missing ? 3 : 0) + (b._compliance.issues.length > 0 ? 1 : 0);
          return bScore - aScore;
        });
        context.res = { body: { summary, devices: enriched } };

      } else if (action === "device" && (email || serial)) {
        const devices = await getAllDevices();
        let device = null;
        if (email) {
          const name = email.split("@")[0].toLowerCase();
          device = devices.find(d =>
            (d.user?.email || "").toLowerCase() === email.toLowerCase() ||
            (d.user?.name || "").toLowerCase().replace(/\s+/g, ".") === name ||
            (d.device_name || "").toLowerCase().includes(name)
          );
        } else if (serial) {
          device = devices.find(d => (d.serial_number || "").toLowerCase() === serial.toLowerCase());
        }

        if (!device) {
          context.res = { body: { found: false } };
          return;
        }

        const details = await getDeviceDetails(device.device_id);
        context.res = { body: { found: true, device: { ...device, _compliance: computeCompliance(device) }, ...details } };

      } else if (action === "vulnerabilities") {
        const vulns = await kandjiGet("/vulnerability-management/vulnerabilities?page=1&page_size=50").catch(() => ({ results: [] }));
        context.res = { body: { vulnerabilities: vulns.results || [] } };

      } else if (action === "stale") {
        // Devices not checked in for 5+ days — for Proactive IT
        const devices = await getAllDevices();
        const stale = devices.filter(d => {
          const days = d.last_check_in ? Math.floor((Date.now() - new Date(d.last_check_in)) / 86400000) : 999;
          return days >= 5;
        }).map(d => ({ ...d, _compliance: computeCompliance(d) }));
        context.res = { body: { stale } };

      } else {
        context.res = { status: 400, body: { error: "Unknown action" } };
      }

    } else {
      // POST — MDM actions
      const { action, deviceId, pin } = req.body || {};
      if (!deviceId) { context.res = { status: 400, body: { error: "deviceId required" } }; return; }

      let result;
      switch (action) {
        case "lock":
          result = await kandjiPost(`/devices/${deviceId}/action/lock`, pin ? { UserMessage: "Device locked by IT", PIN: pin } : { UserMessage: "Device locked by IT" });
          break;
        case "wipe":
          result = await kandjiPost(`/devices/${deviceId}/action/erase`, { PIN: pin || "123456" });
          break;
        case "checkin":
          result = await kandjiPost(`/devices/${deviceId}/action/updateInventory`);
          break;
        case "restart":
          result = await kandjiPost(`/devices/${deviceId}/action/restart`);
          break;
        default:
          context.res = { status: 400, body: { error: `Unknown action: ${action}` } };
          return;
      }
      // Invalidate cache after MDM action
      _deviceCache = null;
      context.res = { body: { ok: true, action, deviceId, result } };
    }
  } catch(err) {
    context.log.error("kandji failed", err);
    context.res = { status: 500, body: { error: err.message } };
  }
};
