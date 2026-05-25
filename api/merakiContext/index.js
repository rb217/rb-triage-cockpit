const { getPrincipal, isInItTeam } = require("../shared/clients");

const MERAKI_BASE = "https://api.meraki.com/api/v1";
let _orgCache = null;
let _networkCache = null;
let _deviceCache = null;
let _cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 min

async function merakiFetch(path) {
  const apiKey = process.env.MERAKI_API_KEY;
  if (!apiKey) throw new Error("MERAKI_API_KEY not configured");
  const res = await fetch(`${MERAKI_BASE}${path}`, {
    headers: {
      "X-Cisco-Meraki-API-Key": apiKey,
      "Content-Type": "application/json"
    }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Meraki ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function getOrgId() {
  if (_orgCache) return _orgCache;
  const orgs = await merakiFetch("/organizations");
  if (!orgs?.length) throw new Error("No Meraki organizations found");
  _orgCache = orgs[0].id;
  return _orgCache;
}

async function getNetworks(orgId) {
  if (_networkCache && Date.now() - _cacheTime < CACHE_TTL) return _networkCache;
  _networkCache = await merakiFetch(`/organizations/${orgId}/networks`);
  return _networkCache || [];
}

async function getDeviceStatuses(orgId) {
  return merakiFetch(`/organizations/${orgId}/devices/statuses`);
}

async function getUplinkStatuses(orgId) {
  try {
    return await merakiFetch(`/organizations/${orgId}/appliance/uplink/statuses`);
  } catch(e) { return []; }
}

module.exports = async function(context, req) {
  const principal = getPrincipal(req);
  if (!isInItTeam(principal)) {
    context.res = { status: 403, body: { error: "Not authorized" } };
    return;
  }

  const type = req.query.type || "overview"; // overview | network | search
  const networkId = req.query.networkId;
  const search = req.query.search?.toLowerCase();

  try {
    const orgId = await getOrgId();
    const [networks, devices, uplinks] = await Promise.all([
      getNetworks(orgId),
      getDeviceStatuses(orgId),
      getUplinkStatuses(orgId)
    ]);

    // Build uplink map: serial -> uplinks
    const uplinkMap = {};
    (uplinks || []).forEach(u => { uplinkMap[u.serial] = u.uplinks || []; });

    // Build network map: networkId -> name
    const networkMap = {};
    (networks || []).forEach(n => { networkMap[n.id] = n.name; });

    // Group devices by network
    const byNetwork = {};
    (devices || []).forEach(d => {
      const nid = d.networkId;
      if (!byNetwork[nid]) byNetwork[nid] = { networkId: nid, networkName: networkMap[nid] || nid, devices: [] };
      byNetwork[nid].devices.push({
        serial: d.serial,
        name: d.name,
        model: d.model,
        status: d.status, // online, offline, alerting, dormant
        lastReportedAt: d.lastReportedAt,
        lanIp: d.lanIp,
        publicIp: d.publicIp,
        productType: d.productType, // appliance, switch, wireless
        uplinks: uplinkMap[d.serial] || []
      });
    });

    // Summary stats
    const allDevices = devices || [];
    const summary = {
      orgId,
      total: allDevices.length,
      online: allDevices.filter(d => d.status === "online").length,
      offline: allDevices.filter(d => d.status === "offline").length,
      alerting: allDevices.filter(d => d.status === "alerting").length,
      networks: networks.length
    };

    if (type === "overview") {
      // Return all networks with their device summary
      const networkList = Object.values(byNetwork).map(n => ({
        ...n,
        summary: {
          total: n.devices.length,
          online: n.devices.filter(d => d.status === "online").length,
          offline: n.devices.filter(d => d.status === "offline").length,
          alerting: n.devices.filter(d => d.status === "alerting").length,
          appliances: n.devices.filter(d => d.productType === "appliance").length,
          switches: n.devices.filter(d => d.productType === "switch").length,
          wireless: n.devices.filter(d => d.productType === "wireless").length,
        }
      })).sort((a, b) => {
        // Sort: networks with issues first
        const aScore = (a.summary.offline * 3) + (a.summary.alerting * 2);
        const bScore = (b.summary.offline * 3) + (b.summary.alerting * 2);
        return bScore - aScore;
      });
      context.res = { body: { summary, networks: networkList } };
    } else if (type === "network" && networkId) {
      const net = byNetwork[networkId] || { networkId, networkName: networkMap[networkId] || networkId, devices: [] };
      context.res = { body: net };
    } else if (type === "search" && search) {
      // Search devices by name across all networks (for ticket context)
      const matches = allDevices.filter(d =>
        (d.name || "").toLowerCase().includes(search) ||
        (networkMap[d.networkId] || "").toLowerCase().includes(search)
      ).slice(0, 10).map(d => ({
        serial: d.serial,
        name: d.name,
        model: d.model,
        status: d.status,
        networkName: networkMap[d.networkId] || d.networkId,
        productType: d.productType,
        uplinks: uplinkMap[d.serial] || []
      }));
      context.res = { body: { matches } };
    } else {
      context.res = { body: { summary, networks: [] } };
    }
  } catch(err) {
    context.log.error("merakiContext failed", err);
    context.res = { status: 500, body: { error: err.message } };
  }
};
