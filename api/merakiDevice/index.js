const { getPrincipal, isInItTeam, callClaude } = require("../shared/clients");

const MERAKI_BASE = "https://api.meraki.com/api/v1";

async function merakiFetch(path) {
  const apiKey = process.env.MERAKI_API_KEY;
  if (!apiKey) throw new Error("MERAKI_API_KEY not configured");
  const res = await fetch(`${MERAKI_BASE}${path}`, {
    headers: { "X-Cisco-Meraki-API-Key": apiKey, "Content-Type": "application/json" }
  });
  if (res.status === 429) throw new Error("Meraki rate limit");
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Meraki ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function safe(fn) { try { return await fn(); } catch(e) { return null; } }

async function getSwitchDetail(serial, networkId) {
  const [ports, portStatuses, lldp] = await Promise.allSettled([
    merakiFetch(`/devices/${serial}/switch/ports`),
    merakiFetch(`/devices/${serial}/switch/ports/statuses`),
    safe(() => merakiFetch(`/devices/${serial}/lldpCdp`))
  ]);

  const portConfigs = ports.status === "fulfilled" ? (ports.value || []) : [];
  const portStats = portStatuses.status === "fulfilled" ? (portStatuses.value || []) : [];
  const lldpData = lldp.status === "fulfilled" ? lldp.value : null;

  const statusMap = {};
  portStats.forEach(p => { statusMap[p.portId] = p; });

  const lldpMap = {};
  if (lldpData?.ports) {
    Object.entries(lldpData.ports).forEach(([portId, data]) => {
      const n = data.lldp || data.cdp;
      if (n) lldpMap[portId] = n;
    });
  }

  const enrichedPorts = portConfigs.map(p => {
    const stat = statusMap[p.portId] || {};
    const neighbor = lldpMap[p.portId];
    return {
      portId: p.portId,
      name: p.name || `Port ${p.portId}`,
      enabled: p.enabled,
      type: p.type,
      vlan: p.vlan,
      allowedVlans: p.allowedVlans,
      poeEnabled: p.poeEnabled,
      status: stat.status,
      speed: stat.speed,
      duplex: stat.duplex,
      powerUsageInWh: stat.powerUsageInWh,
      usageInKb: stat.usageInKb,
      trafficInKbps: stat.trafficInKbps,
      neighbor: neighbor ? {
        name: neighbor.systemName || neighbor.deviceId,
        description: neighbor.systemDescription || neighbor.platform,
        ip: neighbor.managementAddress,
        port: neighbor.portId
      } : null,
      isUplink: p.name?.toLowerCase().includes("uplink") || p.portId === "1",
      hasTraffic: (stat.usageInKb?.total || 0) > 0
    };
  });

  const connected = enrichedPorts.filter(p => p.status === "connected").length;
  const poeActive = enrichedPorts.filter(p => p.poeEnabled && (p.powerUsageInWh || 0) > 0).length;
  const totalPoe = enrichedPorts.reduce((s, p) => s + (p.powerUsageInWh || 0), 0);

  return {
    type: "switch", ports: enrichedPorts,
    summary: { total: enrichedPorts.length, connected, disconnected: enrichedPorts.length - connected, poeActive, totalPoeWh: Math.round(totalPoe) }
  };
}

async function getApplianceDetail(serial, networkId) {
  const [ports, perf, l3, l7, intrusion, malware] = await Promise.allSettled([
    safe(() => merakiFetch(`/networks/${networkId}/appliance/ports`)),
    safe(() => merakiFetch(`/networks/${networkId}/appliance/performance`)),
    safe(() => merakiFetch(`/networks/${networkId}/appliance/firewall/l3FirewallRules`)),
    safe(() => merakiFetch(`/networks/${networkId}/appliance/firewall/l7FirewallRules`)),
    safe(() => merakiFetch(`/networks/${networkId}/appliance/security/intrusion`)),
    safe(() => merakiFetch(`/networks/${networkId}/appliance/security/malware`))
  ]);

  const appPorts = ports.status === "fulfilled" ? (ports.value || []) : [];
  const perfData = perf.status === "fulfilled" ? perf.value : null;
  const l3Rules = l3.status === "fulfilled" ? (l3.value?.rules || []) : [];
  const l7Rules = l7.status === "fulfilled" ? (l7.value?.rules || []) : [];
  const intrusionData = intrusion.status === "fulfilled" ? intrusion.value : null;
  const malwareData = malware.status === "fulfilled" ? malware.value : null;

  const securityPosture = {
    idsMode: intrusionData?.settings?.mode || "unknown",
    idsRulesetType: intrusionData?.settings?.rulesetType,
    ampEnabled: malwareData?.settings?.mode === "enabled",
    l3RuleCount: l3Rules.filter(r => r.comment && !r.comment.toLowerCase().includes("default rule")).length,
    l7RuleCount: l7Rules.filter(r => r.policy === "deny").length,
    hasDefaultDeny: l3Rules.some(r => r.policy === "deny" && r.destCidr === "Any")
  };

  return {
    type: "appliance",
    performance: perfData ? {
      perfScore: perfData.perfScore,
      status: perfData.perfScore >= 80 ? "good" : perfData.perfScore >= 40 ? "degraded" : "poor"
    } : null,
    ports: appPorts,
    securityPosture,
    l3Rules: l3Rules.slice(0, 15),
    l7Rules: l7Rules.slice(0, 10),
    summary: { enabledPorts: appPorts.filter(p => p.enabled).length }
  };
}

async function getWirelessDetail(serial, networkId) {
  const [statusRes, connRes, latencyRes, ssidsRes] = await Promise.allSettled([
    safe(() => merakiFetch(`/devices/${serial}/wireless/status`)),
    safe(() => merakiFetch(`/devices/${serial}/wireless/connectionStats?timespan=3600`)),
    safe(() => merakiFetch(`/devices/${serial}/wireless/latencyStats?timespan=3600`)),
    safe(() => merakiFetch(`/networks/${networkId}/wireless/ssids`))
  ]);

  const status = statusRes.status === "fulfilled" ? statusRes.value : null;
  const connStats = connRes.status === "fulfilled" ? connRes.value : null;
  const latency = latencyRes.status === "fulfilled" ? latencyRes.value : null;
  const ssids = ssidsRes.status === "fulfilled" ? (ssidsRes.value || []) : [];

  const radios = status?.basicServiceSets?.map(bss => ({
    band: bss.band, channel: bss.channel, channelWidth: bss.channelWidth,
    power: bss.power, ssid: bss.ssidName, visible: bss.visible, broadcasting: bss.broadcasting
  })) || [];

  const connQuality = connStats ? {
    assoc: connStats.assoc, auth: connStats.auth,
    dhcp: connStats.dhcp, dns: connStats.dns, success: connStats.success,
    successRate: connStats.assoc > 0 ? Math.round(connStats.success / connStats.assoc * 100) : null
  } : null;

  const activeSSIDs = ssids.filter(s => s.enabled).map(s => ({
    name: s.name, number: s.number, authMode: s.authMode,
    encryptionMode: s.encryptionMode, bandSelection: s.bandSelection
  }));

  // Latency by band
  const latencyByBand = {};
  if (latency) {
    Object.entries(latency).forEach(([key, val]) => {
      if (typeof val === "object" && val.avg !== undefined) {
        latencyByBand[key] = val;
      }
    });
  }

  return {
    type: "wireless", radios, connQuality, activeSSIDs, latencyByBand,
    summary: {
      activeRadios: radios.filter(r => r.broadcasting).length,
      totalRadios: radios.length,
      activeSSIDs: activeSSIDs.length,
      successRate: connQuality?.successRate
    }
  };
}

async function generateDeviceNarrative(name, type, detail) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  let prompt = "";
  if (type === "switch") {
    const { summary, ports } = detail;
    const issues = ports.filter(p => p.enabled && p.status === "disconnected" && !p.isUplink);
    prompt = `Switch "${name}": ${summary.connected}/${summary.total} ports active, ${summary.poeActive} PoE devices, ${summary.totalPoeWh}Wh PoE draw. ${issues.length ? `${issues.length} enabled ports have no link.` : "All enabled ports linked."} Write 1-2 sentences on health and any concerns. No markdown.`;
  } else if (type === "appliance") {
    const { performance, securityPosture } = detail;
    prompt = `MX Firewall "${name}": performance ${performance?.perfScore || "unknown"}/100. IDS=${securityPosture.idsMode}, AMP=${securityPosture.ampEnabled?"on":"off"}, ${securityPosture.l3RuleCount} custom rules, ${securityPosture.l7RuleCount} L7 deny rules, default deny=${securityPosture.hasDefaultDeny}. Write 1-2 sentences on security posture. No markdown.`;
  } else if (type === "wireless") {
    const { summary, connQuality, radios } = detail;
    prompt = `AP "${name}": ${summary.activeRadios} radios, ${summary.activeSSIDs} SSIDs. ${connQuality ? `Success rate ${connQuality.successRate}% (${connQuality.assoc} attempts).` : ""} Channels: ${radios.map(r=>`${r.band} ch${r.channel}`).join(", ")}. Write 1-2 sentences on RF health. No markdown.`;
  }
  try { return await callClaude(prompt, { maxTokens: 120 }); } catch(e) { return null; }
}

module.exports = async function(context, req) {
  const principal = getPrincipal(req);
  if (!isInItTeam(principal)) { context.res = { status: 403, body: { error: "Not authorized" } }; return; }

  const { serial, networkId, type, name } = req.query;
  if (!serial || !networkId || !type) {
    context.res = { status: 400, body: { error: "serial, networkId, type required" } }; return;
  }

  try {
    let detail;
    if (type === "switch") detail = await getSwitchDetail(serial, networkId);
    else if (type === "appliance") detail = await getApplianceDetail(serial, networkId);
    else if (type === "wireless") detail = await getWirelessDetail(serial, networkId);
    else { context.res = { status: 400, body: { error: "type must be switch|appliance|wireless" } }; return; }

    const narrative = await generateDeviceNarrative(name || serial, type, detail);
    context.res = { body: { ...detail, narrative, serial, networkId } };
  } catch(err) {
    context.log.error("merakiDevice failed", err);
    context.res = { status: 500, body: { error: err.message } };
  }
};
