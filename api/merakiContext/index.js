const { getPrincipal, isInItTeam, callClaude } = require("../shared/clients");

const MERAKI_BASE = "https://api.meraki.com/api/v1";
let _orgCache = null, _networkCache = null, _cacheTime = 0;
const CACHE_TTL = 3 * 60 * 1000;

async function merakiFetch(path) {
  const apiKey = process.env.MERAKI_API_KEY;
  if (!apiKey) throw new Error("MERAKI_API_KEY not configured");
  const res = await fetch(`${MERAKI_BASE}${path}`, {
    headers: { "X-Cisco-Meraki-API-Key": apiKey, "Content-Type": "application/json" }
  });
  if (res.status === 429) throw new Error("Meraki rate limit — try again shortly");
  if (!res.ok) throw new Error(`Meraki ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function merakiFetchSafe(path) {
  try { return await merakiFetch(path); } catch(e) { return null; }
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
  _cacheTime = Date.now();
  return _networkCache || [];
}

// ── Claude narratives ─────────────────────────────────────────────────────────
async function generateSiteNarrative(site) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const offlineDevices = site.devices.filter(d => d.status === "offline");
  const alertingDevices = site.devices.filter(d => d.status === "alerting");
  const degradedUplinks = site.devices.flatMap(d =>
    (d.uplinks||[]).filter(u => u.status !== "active").map(u => ({ device: d.name, ...u }))
  );
  const highLatency = site.devices.flatMap(d =>
    Object.entries(d.uplinkPerf||{}).filter(([,p]) => p.avgLatency > 80 || p.avgLoss > 1)
      .map(([iface, p]) => ({ device: d.name, interface: iface, ...p }))
  );
  try {
    return await callClaude(`You are a network engineer. Write a 2-3 sentence plain-English health summary for this site.
Site: ${site.networkName}
Offline: ${offlineDevices.map(d=>d.name).join(", ")||"none"}
Alerting: ${alertingDevices.map(d=>d.name).join(", ")||"none"}
Degraded uplinks: ${JSON.stringify(degradedUplinks)||"none"}
High latency: ${JSON.stringify(highLatency)||"none"}
Be direct. Distinguish ISP vs local issues. Give specific recommended action if needed. No markdown.`, { maxTokens: 200 });
  } catch(e) { return null; }
}

async function generateOrgNarrative(summary, problemSites) {
  if (!process.env.ANTHROPIC_API_KEY || !problemSites.length) return problemSites.length ? null : "All sites healthy.";
  try {
    return await callClaude(`Write a 2-sentence network fleet status for an IT manager.
Total: ${summary.total} devices, ${summary.online} online, ${summary.offline} offline, ${summary.alerting} alerting
Problems: ${problemSites.map(s=>`${s.networkName}(${s.summary.offline}offline,${s.summary.alerting}alerting)`).join(",")}
Be specific. Mention if widespread or isolated. No markdown.`, { maxTokens: 150 });
  } catch(e) { return null; }
}

async function generateDeviceNarrative(device, portData) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const portIssues = (portData?.ports||[]).filter(p => !p.enabled || p.status === "Disconnected" || p.errors?.length);
    const highUtil = (portData?.ports||[]).filter(p => p.trafficInKbps > 50000);
    return await callClaude(`You are a network engineer. Write a 2-sentence health summary for this device.
Device: ${device.name} (${device.model}, ${device.productType})
Status: ${device.status}
${device.productType === "switch" ? `Ports: ${portData?.ports?.length||0} total, ${portIssues.length} with issues, ${highUtil.length} high traffic` : ""}
${device.productType === "appliance" ? `Uplinks: ${JSON.stringify(device.uplinks||[])}` : ""}
${device.productType === "wireless" ? `Clients: ${device.clientCount||0}, Channel util: ${JSON.stringify(device.channelUtilization||{})}` : ""}
Be specific and actionable. No markdown.`, { maxTokens: 150 });
  } catch(e) { return null; }
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async function(context, req) {
  const principal = getPrincipal(req);
  if (!isInItTeam(principal)) { context.res = { status: 403, body: { error: "Not authorized" } }; return; }

  const type = req.query.type || "overview";
  const networkId = req.query.networkId;
  const serial = req.query.serial;
  const withAI = req.query.ai !== "false";

  try {
    const orgId = await getOrgId();
    const networks = await getNetworks(orgId);
    const networkMap = {};
    networks.forEach(n => { networkMap[n.id] = n; });

    // ── DEVICE DETAIL — deep dive for a single device ──────────────────────
    if (type === "device" && serial) {
      const productType = req.query.productType || "switch";

      let deviceData = {};

      if (productType === "switch") {
        const [ports, portStatuses, lldp, clients] = await Promise.allSettled([
          merakiFetch(`/devices/${serial}/switch/ports`),
          merakiFetch(`/devices/${serial}/switch/ports/statuses`),
          merakiFetchSafe(`/devices/${serial}/lldpCdp`),
          merakiFetchSafe(`/devices/${serial}/clients?timespan=300`)
        ]);

        const portConfigs = ports.status === "fulfilled" ? (ports.value || []) : [];
        const portStats = portStatuses.status === "fulfilled" ? (portStatuses.value || []) : [];
        const lldpData = lldp.status === "fulfilled" ? lldp.value : null;
        const deviceClients = clients.status === "fulfilled" ? (clients.value || []) : [];

        // Merge port config with live status
        const mergedPorts = portConfigs.map(pc => {
          const stat = portStats.find(ps => ps.portId === pc.portId) || {};
          const lldpPort = lldpData?.ports?.[pc.portId];
          return {
            portId: pc.portId,
            name: pc.name || `Port ${pc.portId}`,
            enabled: pc.enabled,
            type: pc.type || "access",
            vlan: pc.vlan,
            voiceVlan: pc.voiceVlan,
            allowedVlans: pc.allowedVlans,
            poeEnabled: pc.poeEnabled,
            // Live status
            status: stat.status || "Disconnected",
            speed: stat.speed,
            duplex: stat.duplex,
            usageInKb: stat.usageInKb || {},
            trafficInKbps: stat.trafficInKbps || 0,
            trafficOutKbps: stat.trafficOutKbps || 0,
            warnings: stat.warnings || [],
            errors: stat.errors || [],
            powerUsageInWh: stat.powerUsageInWh,
            isUplink: stat.isUplink || false,
            // CDP/LLDP neighbor
            neighbor: lldpPort?.cdp?.deviceId || lldpPort?.lldp?.systemName || null,
            neighborPort: lldpPort?.cdp?.portId || lldpPort?.lldp?.portId || null,
          };
        });

        // Summary stats
        const connected = mergedPorts.filter(p => p.status === "Connected");
        const disconnected = mergedPorts.filter(p => p.status === "Disconnected" && p.enabled);
        const errored = mergedPorts.filter(p => p.errors?.length > 0);
        const poeActive = mergedPorts.filter(p => p.poeEnabled && p.status === "Connected");
        const highTraffic = mergedPorts.filter(p => (p.trafficInKbps||0) > 50000 || (p.trafficOutKbps||0) > 50000);

        deviceData = {
          type: "switch",
          ports: mergedPorts,
          summary: {
            total: mergedPorts.length,
            connected: connected.length,
            disconnected: disconnected.length,
            errored: errored.length,
            poeActive: poeActive.length,
            highTraffic: highTraffic.length,
            uplinkPorts: mergedPorts.filter(p => p.isUplink).length
          },
          clients: deviceClients.slice(0, 20),
          lldp: lldpData
        };

      } else if (productType === "appliance") {
        const [perfRes, portsRes, firewallRes, vpnRes] = await Promise.allSettled([
          merakiFetchSafe(`/networks/${networkId}/appliance/performance`),
          merakiFetchSafe(`/networks/${networkId}/appliance/ports`),
          merakiFetchSafe(`/networks/${networkId}/appliance/firewall/l3FirewallRules`),
          merakiFetchSafe(`/networks/${networkId}/appliance/vpn/siteToSiteVpn`)
        ]);

        const perf = perfRes.status === "fulfilled" ? perfRes.value : null;
        const ports = portsRes.status === "fulfilled" ? (portsRes.value || []) : [];
        const firewall = firewallRes.status === "fulfilled" ? firewallRes.value : null;
        const vpn = vpnRes.status === "fulfilled" ? vpnRes.value : null;

        deviceData = {
          type: "appliance",
          performance: perf,
          ports: ports.map(p => ({
            number: p.number,
            enabled: p.enabled,
            type: p.type,
            vlan: p.vlan,
            allowedVlans: p.allowedVlans,
            dropUntaggedTraffic: p.dropUntaggedTraffic,
            accessPolicy: p.accessPolicy
          })),
          firewall: {
            ruleCount: firewall?.rules?.length || 0,
            hasDefaultDeny: firewall?.rules?.some(r => r.policy === "deny" && r.srcCidr === "Any") || false
          },
          vpnConfig: vpn ? {
            mode: vpn.mode,
            peerCount: vpn.peers?.length || 0,
            subnetCount: vpn.subnets?.length || 0
          } : null
        };

      } else if (productType === "wireless") {
        const [statusRes, channelRes, connectionRes, clientsRes] = await Promise.allSettled([
          merakiFetchSafe(`/devices/${serial}/wireless/status`),
          merakiFetchSafe(`/networks/${networkId}/wireless/channelUtilization?serials[]=${serial}&timespan=300`),
          merakiFetchSafe(`/devices/${serial}/wireless/connectionStats?timespan=3600`),
          merakiFetchSafe(`/devices/${serial}/clients?timespan=300`)
        ]);

        const status = statusRes.status === "fulfilled" ? statusRes.value : null;
        const channelUtil = channelRes.status === "fulfilled" ? (channelRes.value?.[0] || null) : null;
        const connStats = connectionRes.status === "fulfilled" ? connectionRes.value : null;
        const apClients = clientsRes.status === "fulfilled" ? (clientsRes.value || []) : [];

        // Build radio info
        const radios = status?.basicServiceSets?.reduce((acc, bss) => {
          const band = bss.band || "unknown";
          if (!acc[band]) acc[band] = { band, ssids: [], channel: bss.channel, power: bss.power, clients: 0 };
          acc[band].ssids.push(bss.ssidName);
          acc[band].clients += bss.numClients || 0;
          return acc;
        }, {}) || {};

        deviceData = {
          type: "wireless",
          radios: Object.values(radios),
          channelUtilization: channelUtil ? {
            wifi: channelUtil.wifi80211Percent || 0,
            nonWifi: channelUtil.nonWifi80211Percent || 0,
            total: channelUtil.totalPercent || 0
          } : null,
          connectionStats: connStats ? {
            assoc: connStats.assoc,
            auth: connStats.auth,
            dhcp: connStats.dhcp,
            dns: connStats.dns,
            success: connStats.success,
            successRate: connStats.assoc ? Math.round((connStats.success/connStats.assoc)*100) : null
          } : null,
          clients: apClients.slice(0, 30),
          clientCount: apClients.length
        };
      }

      // Generate AI narrative for device
      const aiNarrative = withAI ? await generateDeviceNarrative(
        { name: serial, model: "", productType, status: "online", uplinks: [], clientCount: deviceData.clientCount },
        deviceData
      ) : null;

      context.res = { body: { serial, productType, ...deviceData, aiNarrative } };
      return;
    }

    // ── OVERVIEW ───────────────────────────────────────────────────────────────
    if (type === "overview") {
      const [devicesRes, uplinksRes, alertsRes] = await Promise.allSettled([
        merakiFetch(`/organizations/${orgId}/devices/statuses`),
        merakiFetch(`/organizations/${orgId}/appliance/uplink/statuses`).catch(() => []),
        merakiFetch(`/organizations/${orgId}/assurance/alerts?active=true&perPage=50`).catch(() => ({ items: [] }))
      ]);

      const allDevices = devicesRes.status === "fulfilled" ? (devicesRes.value || []) : [];
      const allUplinks = uplinksRes.status === "fulfilled" ? (uplinksRes.value || []) : [];
      const allAlerts = alertsRes.status === "fulfilled" ? (alertsRes.value?.items || alertsRes.value || []) : [];

      const uplinkMap = {};
      allUplinks.forEach(u => { uplinkMap[u.serial] = u.uplinks || []; });
      const alertsByNetwork = {};
      allAlerts.forEach(a => { const nid = a.network?.id || a.networkId; if (nid) (alertsByNetwork[nid] = alertsByNetwork[nid]||[]).push(a); });

      const byNetwork = {};
      allDevices.forEach(d => {
        if (!d.networkId) return;
        if (!byNetwork[d.networkId]) byNetwork[d.networkId] = { networkId: d.networkId, networkName: networkMap[d.networkId]?.name || d.networkId, devices: [] };
        byNetwork[d.networkId].devices.push({
          serial: d.serial, name: d.name, model: d.model, status: d.status,
          lastReportedAt: d.lastReportedAt, lanIp: d.lanIp, productType: d.productType,
          uplinks: uplinkMap[d.serial] || [], uplinkPerf: {}
        });
      });

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
        const aScore = (a.summary.offline*3) + (a.summary.alerting*2) + a.summary.alerts;
        const bScore = (b.summary.offline*3) + (b.summary.alerting*2) + b.summary.alerts;
        return bScore - aScore;
      });

      const summary = {
        orgId, total: allDevices.length,
        online: allDevices.filter(d => d.status === "online").length,
        offline: allDevices.filter(d => d.status === "offline").length,
        alerting: allDevices.filter(d => d.status === "alerting").length,
        networks: networks.length, activeAlerts: allAlerts.length
      };

      const problemSites = networkList.filter(n => n.summary.offline > 0 || n.summary.alerting > 0 || n.summary.alerts > 0);
      const orgNarrative = withAI && problemSites.length ? await generateOrgNarrative(summary, problemSites) : null;

      context.res = { body: { summary, networks: networkList, orgNarrative } };
      return;
    }

    // ── NETWORK DETAIL ─────────────────────────────────────────────────────────
    if (type === "network" && networkId) {
      const [devicesRes, uplinkStatusRes, uplinkPerfRes, clientsRes,
             vpnRes, eventsRes, dhcpRes] = await Promise.allSettled([
        merakiFetch(`/organizations/${orgId}/devices/statuses`).then(d => d.filter(x => x.networkId === networkId)),
        merakiFetch(`/organizations/${orgId}/appliance/uplink/statuses`).then(u => u.filter(x => x.networkId === networkId)).catch(() => []),
        merakiFetch(`/organizations/${orgId}/devices/uplinksLossAndLatency?networkId=${networkId}&timespan=3600`).catch(() => []),
        merakiFetch(`/networks/${networkId}/clients?timespan=3600&perPage=50`).catch(() => []),
        merakiFetch(`/organizations/${orgId}/appliance/vpn/statuses?networkIds[]=${networkId}`).catch(() => []),
        merakiFetch(`/networks/${networkId}/events?perPage=10`).catch(() => ({ events: [] })),
        merakiFetchSafe(`/networks/${networkId}/appliance/dhcp/subnets`)
      ]);

      const netDevices = devicesRes.status === "fulfilled" ? devicesRes.value : [];
      const netUplinks = uplinkStatusRes.status === "fulfilled" ? uplinkStatusRes.value : [];
      const netUplinkPerf = uplinkPerfRes.status === "fulfilled" ? (uplinkPerfRes.value || []) : [];
      const netClients = clientsRes.status === "fulfilled" ? (clientsRes.value || []) : [];
      const netVpn = vpnRes.status === "fulfilled" ? (vpnRes.value || []) : [];
      const netEvents = eventsRes.status === "fulfilled" ? (eventsRes.value?.events || []) : [];
      const netDhcp = dhcpRes.status === "fulfilled" && dhcpRes.value ? dhcpRes.value : [];

      const perfMap = {};
      netUplinkPerf.forEach(u => {
        if (!perfMap[u.serial]) perfMap[u.serial] = {};
        const series = u.timeSeries || [];
        const recent = series.slice(-12);
        const avgLoss = recent.length ? recent.reduce((s,t) => s+(t.lossPercent||0),0)/recent.length : 0;
        const avgLatency = recent.length ? recent.reduce((s,t) => s+(t.latencyMs||0),0)/recent.length : 0;
        const maxLatency = Math.max(...recent.map(t => t.latencyMs||0), 0);
        perfMap[u.serial][u.uplink] = {
          avgLoss: Math.round(avgLoss*10)/10,
          avgLatency: Math.round(avgLatency),
          maxLatency: Math.round(maxLatency),
          degraded: avgLoss > 1 || avgLatency > 80
        };
      });

      const osCounts = {};
      netClients.forEach(c => { const os = c.os||"Unknown"; osCounts[os]=(osCounts[os]||0)+1; });
      const clientsByAp = {};
      netClients.forEach(c => { if(c.recentDeviceName) clientsByAp[c.recentDeviceName]=(clientsByAp[c.recentDeviceName]||0)+1; });

      const enrichedDevices = netDevices.map(d => ({
        serial: d.serial, name: d.name, model: d.model, status: d.status,
        lastReportedAt: d.lastReportedAt, lanIp: d.lanIp, publicIp: d.publicIp,
        productType: d.productType, firmware: d.firmware, tags: d.tags||[],
        uplinks: netUplinks.find(u => u.serial === d.serial)?.uplinks || [],
        uplinkPerf: perfMap[d.serial] || {},
        clientCount: clientsByAp[d.name] ?? null
      }));

      const vpnSummary = netVpn.map(v => ({
        networkId: v.networkId, networkName: v.networkName, vpnMode: v.vpnMode,
        peers: (v.vpnPeers||[]).map(p => ({ networkId: p.networkId, networkName: p.networkName, reachability: p.reachability }))
      }));

      const dhcpSummary = netDhcp.map ? netDhcp.map(s => ({
        subnet: s.subnet, mask: s.mask, dnsNameservers: s.dnsNameservers,
        usedCount: s.usedCount, freeCount: s.freeCount,
        utilization: s.usedCount && s.freeCount ? Math.round(s.usedCount/(s.usedCount+s.freeCount)*100) : null
      })) : [];

      let aiNarrative = null;
      if (withAI) {
        aiNarrative = await generateSiteNarrative({ networkName: networkMap[networkId]?.name||networkId, devices: enrichedDevices });
      }

      context.res = { body: {
        networkId, networkName: networkMap[networkId]?.name||networkId,
        devices: enrichedDevices,
        clients: netClients.slice(0, 20), clientTotal: netClients.length, osCounts,
        vpn: vpnSummary, dhcp: dhcpSummary,
        events: netEvents.slice(0, 10),
        aiNarrative, granite: null
      }};
      return;
    }

    // ── SITE AI NARRATIVE ──────────────────────────────────────────────────────
    if (type === "site-ai" && networkId) {
      const [devicesRes, uplinkStatusRes] = await Promise.allSettled([
        merakiFetch(`/organizations/${orgId}/devices/statuses`).then(d => d.filter(x => x.networkId === networkId)),
        merakiFetch(`/organizations/${orgId}/appliance/uplink/statuses`).then(u => u.filter(x => x.networkId === networkId)).catch(() => [])
      ]);
      const devices = (devicesRes.status === "fulfilled" ? devicesRes.value : []).map(d => ({
        ...d,
        uplinks: (uplinkStatusRes.status === "fulfilled" ? uplinkStatusRes.value : []).find(u => u.serial === d.serial)?.uplinks || [],
        uplinkPerf: {}
      }));
      const narrative = await generateSiteNarrative({ networkName: networkMap[networkId]?.name||networkId, devices });
      context.res = { body: { networkId, narrative } };
      return;
    }

    // ── TICKET CONTEXT ─────────────────────────────────────────────────────────
    if (type === "ticket-context") {
      const hint = (req.query.hint || "").toLowerCase();
      const allDevices = await merakiFetch(`/organizations/${orgId}/devices/statuses`);
      const allUplinks = await merakiFetch(`/organizations/${orgId}/appliance/uplink/statuses`).catch(() => []);
      const uplinkMap = {};
      allUplinks.forEach(u => { uplinkMap[u.serial] = u.uplinks || []; });

      let matchedNetworks = networks;
      if (hint) {
        matchedNetworks = networks.filter(n =>
          n.name.toLowerCase().includes(hint) || hint.includes(n.name.toLowerCase().split(" ")[0])
        );
        if (!matchedNetworks.length) matchedNetworks = networks;
      }

      const withIssues = matchedNetworks.map(n => {
        const nDevices = allDevices.filter(d => d.networkId === n.id);
        const offline = nDevices.filter(d => d.status === "offline");
        const alerting = nDevices.filter(d => d.status === "alerting");
        const failedUplinks = [];
        nDevices.forEach(d => {
          (uplinkMap[d.serial]||[]).forEach(u => {
            if (u.status !== "active") failedUplinks.push({ device: d.name, interface: u.interface, status: u.status, ip: u.ip });
          });
        });
        return {
          networkId: n.id, networkName: n.name, total: nDevices.length,
          offline: offline.map(d => ({ name: d.name, model: d.model, type: d.productType, lastSeen: d.lastReportedAt })),
          alerting: alerting.map(d => ({ name: d.name, model: d.model, type: d.productType })),
          failedUplinks,
          hasIssues: offline.length > 0 || alerting.length > 0 || failedUplinks.length > 0
        };
      }).filter(n => n.total > 0);

      context.res = { body: { networks: withIssues } };
      return;
    }

    context.res = { body: { summary: { orgId }, networks: [] } };

  } catch(err) {
    context.log.error("merakiContext failed", err);
    context.res = { status: 500, body: { error: err.message } };
  }
};
