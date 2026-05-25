const { getPrincipal, isInItTeam } = require("../shared/clients");

const MERAKI_BASE = "https://api.meraki.com/api/v1";
let _orgCache = null;
let _networkCache = null;
let _cacheTime = 0;
const CACHE_TTL = 3 * 60 * 1000; // 3 min

async function merakiFetch(path) {
  const apiKey = process.env.MERAKI_API_KEY;
  if (!apiKey) throw new Error("MERAKI_API_KEY not configured");
  const res = await fetch(`${MERAKI_BASE}${path}`, {
    headers: { "X-Cisco-Meraki-API-Key": apiKey, "Content-Type": "application/json" }
  });
  if (res.status === 429) throw new Error("Meraki rate limit hit — try again in a moment");
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Meraki ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function getOrgId() {
  if (_orgCache) return _orgCache;
  const orgs = await merakiFetch("/organizations");
  if (!orgs?.length) throw new Error("No Meraki organizations found for this API key");
  _orgCache = orgs[0].id;
  return _orgCache;
}

async function getNetworks(orgId) {
  if (_networkCache && Date.now() - _cacheTime < CACHE_TTL) return _networkCache;
  _networkCache = await merakiFetch(`/organizations/${orgId}/networks`);
  _cacheTime = Date.now();
  return _networkCache || [];
}

module.exports = async function(context, req) {
  const principal = getPrincipal(req);
  if (!isInItTeam(principal)) {
    context.res = { status: 403, body: { error: "Not authorized" } };
    return;
  }

  const type = req.query.type || "overview";
  const networkId = req.query.networkId;

  try {
    const orgId = await getOrgId();
    const networks = await getNetworks(orgId);

    const networkMap = {};
    networks.forEach(n => { networkMap[n.id] = n; });

    if (type === "overview") {
      // Fetch all data in parallel for overview
      const [devices, uplinks, alerts] = await Promise.allSettled([
        merakiFetch(`/organizations/${orgId}/devices/statuses`),
        merakiFetch(`/organizations/${orgId}/appliance/uplink/statuses`).catch(() => []),
        merakiFetch(`/organizations/${orgId}/assurance/alerts?active=true&perPage=50`).catch(() => ({ items: [] }))
      ]);

      const allDevices = devices.status === "fulfilled" ? (devices.value || []) : [];
      const allUplinks = uplinks.status === "fulfilled" ? (uplinks.value || []) : [];
      const allAlerts = alerts.status === "fulfilled" ? (alerts.value?.items || alerts.value || []) : [];

      // Build maps
      const uplinkMap = {};
      allUplinks.forEach(u => { uplinkMap[u.serial] = u.uplinks || []; });

      const alertsByNetwork = {};
      allAlerts.forEach(a => {
        const nid = a.network?.id || a.networkId;
        if (nid) { alertsByNetwork[nid] = alertsByNetwork[nid] || []; alertsByNetwork[nid].push(a); }
      });

      // Group devices by network
      const byNetwork = {};
      allDevices.forEach(d => {
        const nid = d.networkId;
        if (!byNetwork[nid]) byNetwork[nid] = {
          networkId: nid,
          networkName: networkMap[nid]?.name || nid,
          networkType: networkMap[nid]?.productTypes || [],
          devices: []
        };
        byNetwork[nid].devices.push({
          serial: d.serial,
          name: d.name,
          model: d.model,
          status: d.status,
          lastReportedAt: d.lastReportedAt,
          lanIp: d.lanIp,
          publicIp: d.publicIp,
          productType: d.productType,
          uplinks: uplinkMap[d.serial] || []
        });
      });

      // Build network list with summaries
      const networkList = Object.values(byNetwork).map(n => {
        const networkAlerts = alertsByNetwork[n.networkId] || [];
        const summary = {
          total: n.devices.length,
          online: n.devices.filter(d => d.status === "online").length,
          offline: n.devices.filter(d => d.status === "offline").length,
          alerting: n.devices.filter(d => d.status === "alerting").length,
          appliances: n.devices.filter(d => d.productType === "appliance").length,
          switches: n.devices.filter(d => d.productType === "switch").length,
          wireless: n.devices.filter(d => d.productType === "wireless").length,
          alerts: networkAlerts.length
        };
        return { ...n, summary, alerts: networkAlerts.slice(0, 5) };
      }).sort((a, b) => {
        const aScore = (a.summary.offline * 3) + (a.summary.alerting * 2) + (a.summary.alerts);
        const bScore = (b.summary.offline * 3) + (b.summary.alerting * 2) + (b.summary.alerts);
        return bScore - aScore;
      });

      const summary = {
        orgId,
        total: allDevices.length,
        online: allDevices.filter(d => d.status === "online").length,
        offline: allDevices.filter(d => d.status === "offline").length,
        alerting: allDevices.filter(d => d.status === "alerting").length,
        networks: networks.length,
        activeAlerts: allAlerts.length
      };

      context.res = { body: { summary, networks: networkList } };

    } else if (type === "network" && networkId) {
      // Deep dive for a single network
      const [devices, uplinkStatus, uplinkPerf, clients, switchPorts, vpnStatus] = await Promise.allSettled([
        merakiFetch(`/organizations/${orgId}/devices/statuses`).then(d => d.filter(x => x.networkId === networkId)),
        merakiFetch(`/organizations/${orgId}/appliance/uplink/statuses`).then(u => u.filter(x => x.networkId === networkId)).catch(() => []),
        merakiFetch(`/organizations/${orgId}/devices/uplinksLossAndLatency?networkId=${networkId}&timespan=300`).catch(() => []),
        merakiFetch(`/networks/${networkId}/clients?timespan=300&perPage=20`).catch(() => []),
        merakiFetch(`/organizations/${orgId}/switch/ports/bySwitch?networkIds[]=${networkId}&perPage=5`).catch(() => ({ data: [] })),
        merakiFetch(`/organizations/${orgId}/appliance/vpn/statuses?networkIds[]=${networkId}`).catch(() => [])
      ]);

      const netDevices = devices.status === "fulfilled" ? devices.value : [];
      const netUplinks = uplinkStatus.status === "fulfilled" ? uplinkStatus.value : [];
      const netUplinkPerf = uplinkPerf.status === "fulfilled" ? (uplinkPerf.value || []) : [];
      const netClients = clients.status === "fulfilled" ? (clients.value || []) : [];
      const netSwitchPorts = switchPorts.status === "fulfilled" ? (switchPorts.value?.data || []) : [];
      const netVpn = vpnStatus.status === "fulfilled" ? (vpnStatus.value || []) : [];

      // Build uplink performance map: serial -> { wan1: {loss, latency}, wan2: {...} }
      const perfMap = {};
      netUplinkPerf.forEach(u => {
        if (!perfMap[u.serial]) perfMap[u.serial] = {};
        const recent = u.timeSeries?.slice(-3) || [];
        const avgLoss = recent.reduce((s, t) => s + (t.lossPercent || 0), 0) / (recent.length || 1);
        const avgLatency = recent.reduce((s, t) => s + (t.latencyMs || 0), 0) / (recent.length || 1);
        perfMap[u.serial][u.uplink] = {
          avgLoss: Math.round(avgLoss * 10) / 10,
          avgLatency: Math.round(avgLatency)
        };
      });

      // Client count per AP
      const clientsByAp = {};
      netClients.forEach(c => {
        if (c.recentDeviceName) {
          clientsByAp[c.recentDeviceName] = (clientsByAp[c.recentDeviceName] || 0) + 1;
        }
      });

      const enrichedDevices = netDevices.map(d => ({
        serial: d.serial,
        name: d.name,
        model: d.model,
        status: d.status,
        lastReportedAt: d.lastReportedAt,
        lanIp: d.lanIp,
        publicIp: d.publicIp,
        productType: d.productType,
        uplinks: netUplinks.find(u => u.serial === d.serial)?.uplinks || [],
        uplinkPerf: perfMap[d.serial] || {},
        clientCount: clientsByAp[d.name] || null
      }));

      context.res = {
        body: {
          networkId,
          networkName: networkMap[networkId]?.name || networkId,
          devices: enrichedDevices,
          clients: netClients.slice(0, 10),
          switchPorts: netSwitchPorts.slice(0, 5),
          vpn: netVpn,
          clientTotal: netClients.length
        }
      };

    } else if (type === "ticket-context") {
      // For a network ticket — find most relevant network based on site name hint
      const hint = (req.query.hint || "").toLowerCase();
      const allDevices = await merakiFetch(`/organizations/${orgId}/devices/statuses`);
      const allUplinks = await merakiFetch(`/organizations/${orgId}/appliance/uplink/statuses`).catch(() => []);
      const uplinkMap = {};
      allUplinks.forEach(u => { uplinkMap[u.serial] = u.uplinks || []; });

      // Find networks matching the hint
      let matchedNetworks = networks;
      if (hint) {
        matchedNetworks = networks.filter(n =>
          n.name.toLowerCase().includes(hint) ||
          hint.includes(n.name.toLowerCase().split(" ")[0])
        );
        if (!matchedNetworks.length) matchedNetworks = networks;
      }

      // Return summary of all networks with issues
      const withIssues = matchedNetworks.map(n => {
        const nDevices = allDevices.filter(d => d.networkId === n.id);
        const offline = nDevices.filter(d => d.status === "offline");
        const alerting = nDevices.filter(d => d.status === "alerting");
        const failedUplinks = [];
        nDevices.forEach(d => {
          const ups = uplinkMap[d.serial] || [];
          ups.forEach(u => { if (u.status !== "active") failedUplinks.push({ device: d.name, interface: u.interface, status: u.status }); });
        });
        return {
          networkId: n.id,
          networkName: n.name,
          total: nDevices.length,
          offline: offline.map(d => ({ name: d.name, model: d.model, type: d.productType, lastSeen: d.lastReportedAt })),
          alerting: alerting.map(d => ({ name: d.name, model: d.model, type: d.productType })),
          failedUplinks,
          hasIssues: offline.length > 0 || alerting.length > 0 || failedUplinks.length > 0
        };
      }).filter(n => n.total > 0);

      context.res = { body: { networks: withIssues } };

    } else {
      context.res = { body: { summary: { orgId }, networks: [] } };
    }

  } catch(err) {
    context.log.error("merakiContext failed", err);
    context.res = { status: 500, body: { error: err.message } };
  }
};
