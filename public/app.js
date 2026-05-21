let cy;
let topology = null;
let refreshTimer = null;
let dashOffset = 0;
let activeView = "map";

const els = {
  title: document.getElementById("title"), subtitle: document.getElementById("subtitle"), modeBadge: document.getElementById("modeBadge"), sourceBadge: document.getElementById("sourceBadge"),
  searchBox: document.getElementById("searchBox"), roleFilter: document.getElementById("roleFilter"), refreshInterval: document.getElementById("refreshInterval"), refreshBtn: document.getElementById("refreshBtn"),
  fitBtn: document.getElementById("fitBtn"), resetBtn: document.getElementById("resetBtn"), lastUpdated: document.getElementById("lastUpdated"), panelTitle: document.getElementById("panelTitle"),
  panelSub: document.getElementById("panelSub"), panelStatus: document.getElementById("panelStatus"), panelBody: document.getElementById("panelBody"), toast: document.getElementById("toast")
};

function fmtMbps(value) { const n = Number(value || 0); if (n >= 1000) return `${(n / 1000).toFixed(2)} Gbps`; if (n >= 100) return `${n.toFixed(0)} Mbps`; if (n >= 10) return `${n.toFixed(1)} Mbps`; return `${n.toFixed(2)} Mbps`; }
function fmtPct(value) { const n = Number(value || 0); if (n >= 100) return `${n.toFixed(0)}%`; if (n >= 10) return `${n.toFixed(1)}%`; return `${n.toFixed(2)}%`; }
function esc(v) { return String(v ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;"); }
function colorByUtil(u) { u = Number(u || 0); if (u >= 100) return "#ff4d5a"; if (u >= 75) return "#ff8f2a"; if (u >= 50) return "#ffca3a"; if (u >= 25) return "#c7df42"; return "#48d16f"; }
function colorByRole(d) { if (d.status !== "up") return "#ff4d5a"; if (d.alerts > 0) return "#ffca3a"; return ({edge:"#35e3ff", firewall:"#38a8ff", core:"#48d16f", access:"#c7df42", wireless:"#35e3ff", server:"#a78bfa", network:"#8fa9c1"})[d.role] || "#8fa9c1"; }
function iconByRole(role) { return ({edge:"EDGE", firewall:"FW", core:"CORE", access:"SW", wireless:"AP", server:"SRV", network:"NET"})[role] || "NET"; }
function showToast(message, timeout = 4500) { if (!message) return; els.toast.textContent = message; els.toast.classList.remove("hidden"); clearTimeout(showToast._timer); showToast._timer = setTimeout(() => els.toast.classList.add("hidden"), timeout); }
function savedPositions() { try { return JSON.parse(localStorage.getItem("netmap.positions.v3") || "{}"); } catch { return {}; } }
function savePositions() { if (!cy) return; const out = {}; cy.nodes().forEach(node => out[node.id()] = node.position()); localStorage.setItem("netmap.positions.v3", JSON.stringify(out)); }
function clearPositions() { localStorage.removeItem("netmap.positions.v3"); renderTopology(true); showToast("Saved layout cleared."); }
function rank(d) { return ({edge:0, firewall:1, core:2, access:3, wireless:4, server:5, network:6})[d.role] ?? 9; }

function guessedPositions(devices) {
  const width = Math.max(document.getElementById("cy").clientWidth, 1120);
  const center = width / 2;
  const positions = {};
  const byRole = role => devices.filter(d => d.role === role).sort((a,b) => a.label.localeCompare(b.label));
  function place(items, y, spacing, xCenter = center) { const count = Math.max(items.length, 1); items.forEach((d,i) => positions[d.id] = { x: xCenter + (i - (count - 1) / 2) * spacing, y }); }
  place(byRole("edge"), 120, 280, center - 360);
  place(byRole("firewall"), 120, 260, center + 360);
  place(byRole("core"), 280, 330, center);
  place(byRole("access"), 470, 240, center - 140);
  place(byRole("wireless"), 650, 220, center - 140);
  place(byRole("server"), 650, 220, center + 360);
  let idx = 0;
  for (const d of [...devices].sort((a,b) => rank(a) - rank(b) || a.label.localeCompare(b.label))) if (!positions[d.id]) positions[d.id] = { x: 160 + (idx % 5) * 210, y: 820 + Math.floor(idx++ / 5) * 140 };
  return positions;
}

function buildElements(data, forceAuto = false) {
  const saved = forceAuto ? {} : savedPositions();
  const guessed = guessedPositions(data.devices);
  const nodes = data.devices.map(d => ({ data: { id:d.id, label:d.label, role:d.role, vendor:d.vendor, badge:iconByRole(d.role), subtitle:[d.ip || d.hostname || "", d.vendor && d.vendor !== "unknown" ? d.vendor : ""].filter(Boolean).join(" | "), color:colorByRole(d), status:d.status, alerts:d.alerts || 0, raw:d }, position: saved[d.id] || guessed[d.id] }));
  const edges = data.links.map(l => { const util = Number(l.utilPct || 0); const traffic = Math.max(Number(l.inMbps || 0), Number(l.outMbps || 0)); return { data: { id:l.id, source:l.source, target:l.target, label:`${fmtMbps(l.inMbps)} down / ${fmtMbps(l.outMbps)} up`, color:colorByUtil(util), width:Math.max(2, Math.min(13, 2 + Math.sqrt(Math.max(traffic, 1)) / 3.5)), util, raw:l } }; });
  return [...nodes, ...edges];
}

function initCy() {
  cy = cytoscape({
    container: document.getElementById("cy"), elements: [], layout: { name:"preset" }, wheelSensitivity:0.16, minZoom:0.25, maxZoom:2.2,
    style: [
      { selector:"node", style:{ "shape":"round-rectangle", "width":136, "height":72, "background-color":"data(color)", "background-opacity":0.13, "border-color":"data(color)", "border-width":2, "border-opacity":0.95, "label":ele => `${ele.data("badge")}  ${ele.data("label")}\n${ele.data("subtitle")}`, "text-wrap":"wrap", "text-max-width":160, "text-valign":"center", "text-halign":"center", "font-size":11, "font-weight":750, "color":"#eef7ff", "text-outline-width":2, "text-outline-color":"#06101c", "shadow-blur":20, "shadow-color":"data(color)", "shadow-opacity":0.30, "shadow-offset-x":0, "shadow-offset-y":0 } },
      { selector:'node[status = "down"]', style:{ "border-style":"dashed", "background-opacity":0.07 } },
      { selector:'node[alerts > 0]', style:{ "border-width":3 } },
      { selector:"edge", style:{ "curve-style":"bezier", "width":"data(width)", "line-color":"data(color)", "target-arrow-color":"data(color)", "source-arrow-color":"data(color)", "target-arrow-shape":"triangle", "source-arrow-shape":"triangle", "arrow-scale":.7, "opacity":.88, "label":"data(label)", "font-size":10, "color":"#dceeff", "text-outline-color":"#06101c", "text-outline-width":3, "text-background-color":"#06101c", "text-background-opacity":.62, "text-background-padding":4, "line-style":"dashed", "line-dash-pattern":[12,9], "line-dash-offset":0 } },
      { selector:":selected", style:{ "border-color":"#ffffff", "line-color":"#ffffff", "target-arrow-color":"#ffffff", "source-arrow-color":"#ffffff" } },
      { selector:".faded", style:{ "opacity":.12 } },
      { selector:".hiddenByFilter", style:{ "display":"none" } }
    ]
  });
  cy.on("dragfree", "node", savePositions);
  cy.on("tap", "node", event => { activeView = "map"; setActiveNav("map"); focusNeighborhood(event.target); showDevice(event.target.data("raw")); });
  cy.on("tap", "edge", event => { activeView = "map"; setActiveNav("map"); showLink(event.target.data("raw")); });
  cy.on("tap", event => { if (event.target === cy) { cy.elements().removeClass("faded"); if (activeView === "map") showMapPanel(); } });
  setInterval(() => { if (!cy) return; dashOffset = (dashOffset - 1) % 22; cy.edges().style("line-dash-offset", dashOffset); }, 80);
}

function focusNeighborhood(node) { cy.elements().addClass("faded"); node.removeClass("faded"); node.connectedEdges().removeClass("faded"); node.connectedEdges().connectedNodes().removeClass("faded"); }
function renderTopology(forceAuto = false) { if (!topology || !cy) return; cy.elements().remove(); cy.add(buildElements(topology, forceAuto)); cy.layout({ name:"preset", fit:true, padding:74 }).run(); cy.fit(undefined, 74); updateSummary(); applyRoleFilter(); renderActivePanel(); }

function updateSummary() {
  const d = topology, s = d.summary || {}, totalTraffic = Number(s.totalInMbps || 0) + Number(s.totalOutMbps || 0);
  els.title.textContent = d.title || "NetMap"; els.subtitle.textContent = d.subtitle || "LibreNMS topology dashboard"; els.modeBadge.textContent = d.mode || "live"; els.modeBadge.className = d.mode === "mock" ? "mock" : "live"; els.sourceBadge.textContent = d.mode === "mock" ? "Demo data" : "LibreNMS";
  document.getElementById("kpiDevices").textContent = s.totalDevices || 0; document.getElementById("kpiDevicesSub").textContent = `${s.upDevices || 0} up / ${s.downDevices || 0} down`;
  document.getElementById("kpiPorts").textContent = s.totalPorts || 0; document.getElementById("kpiPortsSub").textContent = `${s.upPorts || 0} up / ${s.downPorts || 0} down`;
  document.getElementById("kpiLinks").textContent = s.totalLinks || 0; document.getElementById("kpiTraffic").textContent = fmtMbps(totalTraffic); document.getElementById("kpiTrafficSub").textContent = `down ${fmtMbps(s.totalInMbps)} / up ${fmtMbps(s.totalOutMbps)}`; document.getElementById("kpiAlerts").textContent = s.activeAlerts || 0;
  document.getElementById("railUp").textContent = `${s.upDevices || 0} up`; document.getElementById("railDown").textContent = `${s.downDevices || 0} down`; document.getElementById("railAlerts").textContent = `${s.activeAlerts || 0} alerts`; document.getElementById("railPorts").textContent = s.totalPorts || 0; document.getElementById("railPortsUp").textContent = `${s.upPorts || 0} up`; document.getElementById("railPortsDown").textContent = `${s.downPorts || 0} down`; document.getElementById("railTraffic").textContent = fmtMbps(totalTraffic); document.getElementById("railIn").textContent = `down ${fmtMbps(s.totalInMbps)}`; document.getElementById("railOut").textContent = `up ${fmtMbps(s.totalOutMbps)}`; document.getElementById("navAlerts").textContent = s.activeAlerts || 0;
  els.lastUpdated.textContent = `Updated ${new Date(d.generatedAt).toLocaleTimeString()}`;
  const warnings = Object.values(d.warnings || {}).filter(Boolean); if (warnings.length) showToast(warnings[0]);
}

async function loadTopology({ forceAuto = false } = {}) {
  els.refreshBtn.disabled = true; els.refreshBtn.textContent = "Loading...";
  try {
    const res = await fetch("/api/topology", { cache:"no-store" }); const data = await res.json(); if (!res.ok || data.status !== "ok") throw new Error(data.message || "Topology fetch failed."); topology = data;
    if (data.settings?.defaultRefreshMs && !loadTopology._didSetRefresh) { const wanted = String(data.settings.defaultRefreshMs); const option = [...els.refreshInterval.options].find(o => o.value === wanted); if (option) els.refreshInterval.value = wanted; loadTopology._didSetRefresh = true; scheduleRefresh(); }
    renderTopology(forceAuto);
  } catch (err) { showToast(err.message || String(err), 8000); }
  finally { els.refreshBtn.disabled = false; els.refreshBtn.textContent = "Refresh"; }
}


function roleTag(role) {
  return `<span class="tag">${escapeHtml(role || "unknown")}</span>`;
}

function vendorTag(vendor) {
  return `<span class="tag">${escapeHtml(vendor || "unknown")}</span>`;
}

function endpointRow(name, path) {
  return `
    <div class="item endpoint-row" data-endpoint="${escapeHtml(path)}">
      <div class="item-title">
        <span>${escapeHtml(name)}</span>
        <span class="endpoint-state">not checked</span>
      </div>
      <div class="item-sub">${escapeHtml(path)}</div>
    </div>
  `;
}

async function runEndpointDiagnostics() {
  const rows = [...document.querySelectorAll("[data-endpoint]")];

  for (const row of rows) {
    const path = row.dataset.endpoint;
    const state = row.querySelector(".endpoint-state");
    state.textContent = "checking...";

    try {
      const res = await fetch(path, { cache: "no-store" });
      const data = await res.json();
      if (res.ok && data.status === "ok") {
        state.textContent = "ok";
        state.className = "endpoint-state good-text";
      } else {
        state.textContent = `error ${res.status}`;
        state.className = "endpoint-state bad-text";
      }
    } catch (err) {
      state.textContent = "failed";
      state.className = "endpoint-state bad-text";
    }
  }
}

function copyDiagnostics() {
  const payload = {
    generatedAt: topology?.generatedAt,
    mode: topology?.mode,
    source: topology?.source,
    summary: topology?.summary,
    settings: topology?.settings,
    vendors: topology?.summary?.vendorCounts,
    roles: topology?.summary?.roleCounts
  };

  navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
    .then(() => showToast("Diagnostics copied to clipboard."))
    .catch(() => showToast("Could not copy diagnostics."));
}

function setPill(text, kind = "neutral") { els.panelStatus.textContent = text; els.panelStatus.className = `pill ${kind}`; }
function tagRows(obj) { return Object.entries(obj || {}).map(([k,v]) => `<span class="tag">${esc(k)}: ${v}</span>`).join(""); }
function showMapPanel() { els.panelTitle.textContent = "Map"; els.panelSub.textContent = "Click a node or link to inspect it."; setPill("ready"); els.panelBody.innerHTML = `<p class="empty">This map is built from LibreNMS devices, discovered links, interface counters, and alerts. Drag nodes to adjust the layout; your browser saves the positions.</p><h3>Roles</h3><div class="tag-row">${tagRows(topology.summary?.roleCounts)}</div><h3>Vendors</h3><div class="tag-row">${tagRows(topology.summary?.vendorCounts)}</div><div class="kv"><span>Layout</span><strong>Generic enterprise fabric</strong></div><div class="kv"><span>Traffic</span><strong>Animated from interface counters</strong></div><div class="kv"><span>Refresh</span><strong>${Number(els.refreshInterval.value) / 1000}s</strong></div>`; }
function showOverview() { const s = topology.summary, busiestLinks = [...topology.links].sort((a,b) => Math.max(b.inMbps,b.outMbps) - Math.max(a.inMbps,a.outMbps)).slice(0,5), busiestPorts = [...topology.ports].sort((a,b) => Number(b.utilPct || 0) - Number(a.utilPct || 0)).slice(0,5); els.panelTitle.textContent = "Overview"; els.panelSub.textContent = "Network health, vendors, roles, and busiest interfaces."; setPill(topology.mode, topology.mode === "mock" ? "warn" : "good"); els.panelBody.innerHTML = `<div class="kv"><span>Devices</span><strong>${s.totalDevices}</strong></div><div class="kv"><span>Interfaces</span><strong>${s.totalPorts}</strong></div><div class="kv"><span>Links</span><strong>${s.totalLinks}</strong></div><div class="kv"><span>Traffic</span><strong>${fmtMbps(s.totalInMbps + s.totalOutMbps)}</strong></div><div class="kv"><span>Alerts</span><strong>${s.activeAlerts}</strong></div><h3>Vendors</h3><div class="tag-row">${tagRows(s.vendorCounts)}</div><h3>Busiest Interfaces</h3><div class="list">${busiestPorts.map(portCard).join("") || `<p class="empty">No interface counters found.</p>`}</div><h3>Busiest Links</h3><div class="list">${busiestLinks.map(linkCard).join("") || `<p class="empty">No links found.</p>`}</div>`; }
function showDevices() {
  const devices = [...topology.devices].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
  const roleCounts = topology.summary?.roleCounts || {};
  const vendorCounts = topology.summary?.vendorCounts || {};

  els.panelTitle.textContent = "Devices";
  els.panelSub.textContent = `${devices.length} monitored devices from LibreNMS.`;
  setPill(`${devices.length} devices`);

  els.panelBody.innerHTML = `
    <div class="tag-row">
      ${Object.entries(roleCounts).map(([k, v]) => `<span class="tag">${escapeHtml(k)}: ${v}</span>`).join("")}
    </div>
    <div class="tag-row">
      ${Object.entries(vendorCounts).map(([k, v]) => `<span class="tag">${escapeHtml(k)}: ${v}</span>`).join("")}
    </div>

    <div class="table device-table">
      <div class="table-row header">
        <span>Device</span><span>Role</span><span>Vendor</span><span>IP</span><span>Ports</span><span>Traffic</span><span>Alerts</span>
      </div>
      ${devices.map(d => `
        <div class="table-row clickable item" data-node="${escapeHtml(d.id)}">
          <strong title="${escapeHtml(d.hostname || d.label)}">${escapeHtml(d.label)}</strong>
          <span><i class="role-dot" style="background:${colorByRole(d)}"></i>${escapeHtml(d.role)}</span>
          <span>${escapeHtml(d.vendor || "unknown")}</span>
          <span>${escapeHtml(d.ip || "—")}</span>
          <span>${d.upPorts || 0}/${d.ports || 0}</span>
          <span>${fmtMbps((d.trafficInMbps || 0) + (d.trafficOutMbps || 0))}</span>
          <span>${d.alerts || 0}</span>
        </div>
      `).join("")}
    </div>
  `;

  els.panelBody.querySelectorAll("[data-node]").forEach(el => {
    el.addEventListener("click", () => {
      const node = cy.getElementById(el.dataset.node);
      if (node.length) {
        activeView = "map";
        setActiveNav("map");
        cy.animate({ center: { eles: node }, zoom: 1.05 }, { duration: 300 });
        node.select();
        focusNeighborhood(node);
        showDevice(node.data("raw"));
      }
    });
  });
}


function showInterfaces() {
  const ports = [...topology.ports].sort((a, b) => Number(b.utilPct || 0) - Number(a.utilPct || 0));
  const up = ports.filter(p => String(p.ifOperStatus).toLowerCase() === "up").length;
  const down = ports.length - up;

  els.panelTitle.textContent = "Interfaces";
  els.panelSub.textContent = `${ports.length} interfaces. ${up} up / ${down} down.`;
  setPill(`${ports.length} ports`);

  els.panelBody.innerHTML = `
    <div class="tag-row">
      <span class="tag">up: ${up}</span>
      <span class="tag">down: ${down}</span>
      <span class="tag">traffic: ${fmtMbps(ports.reduce((sum, p) => sum + Number(p.inMbps || 0) + Number(p.outMbps || 0), 0))}</span>
    </div>

    <div class="table interface-table">
      <div class="table-row header">
        <span>Interface</span><span>Device</span><span>Alias</span><span>Status</span><span>Speed</span><span>Traffic</span><span>Util</span>
      </div>
      ${ports.map(p => `
        <div class="table-row item">
          <strong title="${escapeHtml(p.ifDescr || p.name)}">${escapeHtml(p.name)}</strong>
          <span>${escapeHtml(p.device_label || p.device_id)}</span>
          <span title="${escapeHtml(p.ifAlias || "")}">${escapeHtml(p.ifAlias || "—")}</span>
          <span class="${String(p.ifOperStatus).toLowerCase() === "up" ? "good-text" : "bad-text"}">${escapeHtml(p.ifOperStatus || "unknown")}</span>
          <span>${escapeHtml(p.speedLabel || "unknown")}</span>
          <span>↓ ${fmtMbps(p.inMbps)} ↑ ${fmtMbps(p.outMbps)}</span>
          <span>${fmtPct(p.utilPct)}</span>
        </div>
      `).join("") || `<p class="empty">No interfaces returned from LibreNMS.</p>`}
    </div>
  `;
}


function showLinks() {
  const links = [...topology.links].sort((a, b) => Number(b.utilPct || 0) - Number(a.utilPct || 0));
  els.panelTitle.textContent = "Links";
  els.panelSub.textContent = `${links.length} LLDP/CDP/xDP discovered topology links.`;
  setPill(`${links.length} links`);

  els.panelBody.innerHTML = `
    <div class="table link-table">
      <div class="table-row header">
        <span>Local</span><span>Local Port</span><span>Remote</span><span>Remote Port</span><span>Speed</span><span>Traffic</span><span>Util</span>
      </div>
      ${links.map(l => `
        <div class="table-row item">
          <strong>${escapeHtml(l.localDeviceLabel || l.source)}</strong>
          <span title="${escapeHtml(l.localPortName || "")}">${escapeHtml(l.localPortName || "—")}</span>
          <strong>${escapeHtml(l.remoteDeviceLabel || l.target)}</strong>
          <span title="${escapeHtml(l.remotePortName || "")}">${escapeHtml(l.remotePortName || "—")}</span>
          <span>${escapeHtml(l.speedLabel || "unknown")}</span>
          <span>↓ ${fmtMbps(l.inMbps)} ↑ ${fmtMbps(l.outMbps)}</span>
          <span>${fmtPct(l.utilPct)}</span>
        </div>
      `).join("") || `<p class="empty">No discovered links found.</p>`}
    </div>
  `;
}


function showAlerts() { const alerts = topology.alerts || []; els.panelTitle.textContent = "Alerts"; els.panelSub.textContent = `${alerts.length} active alert records.`; setPill(alerts.length ? "active" : "clear", alerts.length ? "warn" : "good"); els.panelBody.innerHTML = `<div class="list">${alerts.map(a => `<div class="item"><div class="item-title"><span>${esc(a.title || a.rule || a.name || "Alert")}</span><span>${esc(a.severity || a.state || "active")}</span></div><div class="item-sub">${esc(a.hostname || a.device || a.device_id || "")} | ${esc(a.timestamp || a.time_logged || "")}</div></div>`).join("") || `<p class="empty">No active alerts returned.</p>`}</div>`; }
function showSettings() {
  const settings = topology.settings || {};
  const s = topology.summary || {};

  els.panelTitle.textContent = "Settings";
  els.panelSub.textContent = "Runtime diagnostics and dashboard behavior.";
  setPill("diagnostics");

  els.panelBody.innerHTML = `
    <h3>Runtime</h3>
    <div class="kv"><span>Mode</span><strong>${escapeHtml(topology.mode)}</strong></div>
    <div class="kv"><span>Source</span><strong>${escapeHtml(topology.source)}</strong></div>
    <div class="kv"><span>Updated</span><strong>${escapeHtml(new Date(topology.generatedAt).toLocaleString())}</strong></div>
    <div class="kv"><span>Default refresh</span><strong>${Number(settings.defaultRefreshMs || Number(els.refreshInterval.value)) / 1000}s</strong></div>
    <div class="kv"><span>Hide down interfaces</span><strong>${settings.hideDownInterfaces ? "yes" : "no"}</strong></div>

    <h3>Current Dataset</h3>
    <div class="kv"><span>Devices</span><strong>${s.totalDevices || 0}</strong></div>
    <div class="kv"><span>Interfaces</span><strong>${s.totalPorts || 0}</strong></div>
    <div class="kv"><span>Links</span><strong>${s.totalLinks || 0}</strong></div>
    <div class="kv"><span>Traffic</span><strong>${fmtMbps((s.totalInMbps || 0) + (s.totalOutMbps || 0))}</strong></div>

    <h3>Endpoint Diagnostics</h3>
    <div class="list">
      ${endpointRow("Health", "/api/health")}
      ${endpointRow("Topology", "/api/topology")}
      ${endpointRow("Devices", "/api/devices")}
      ${endpointRow("Interfaces", "/api/interfaces")}
      ${endpointRow("Links", "/api/links")}
    </div>

    <div class="button-row">
      <button id="runDiagnosticsBtn">Run checks</button>
      <button id="copyDiagnosticsBtn">Copy diagnostics</button>
    </div>

    <p class="empty">Classification hints, LibreNMS URL, token, mock mode, and refresh defaults are controlled in the server .env file.</p>
  `;

  document.getElementById("runDiagnosticsBtn")?.addEventListener("click", runEndpointDiagnostics);
  document.getElementById("copyDiagnosticsBtn")?.addEventListener("click", copyDiagnostics);
}


function statusKind(d) { if (d.status !== "up") return "bad"; if ((d.alerts || 0) > 0) return "warn"; return "good"; }
function showDevice(d) { const links = topology.links.filter(l => l.source === d.id || l.target === d.id), ports = topology.ports.filter(p => p.device_id === d.device_id).sort((a,b) => Number(b.utilPct || 0) - Number(a.utilPct || 0)).slice(0,12); els.panelTitle.textContent = d.label; els.panelSub.textContent = `${d.role.toUpperCase()} | ${d.vendor || "unknown"} | ${d.ip || d.hostname || "No IP"}`; setPill(d.status, statusKind(d)); els.panelBody.innerHTML = `<div class="kv"><span>Hostname</span><strong>${esc(d.hostname || d.sysName || "-")}</strong></div><div class="kv"><span>IP</span><strong>${esc(d.ip || "-")}</strong></div><div class="kv"><span>Role</span><strong>${esc(d.role || "-")}</strong></div><div class="kv"><span>Vendor</span><strong>${esc(d.vendor || "unknown")}</strong></div><div class="kv"><span>OS</span><strong>${esc(d.os || "-")}</strong></div><div class="kv"><span>Hardware</span><strong>${esc(d.hardware || "-")}</strong></div><div class="kv"><span>Location</span><strong>${esc(d.location || "-")}</strong></div><div class="kv"><span>Ports</span><strong>${d.upPorts || 0}/${d.ports || 0} up</strong></div><div class="kv"><span>Traffic</span><strong>down ${fmtMbps(d.trafficInMbps)} up ${fmtMbps(d.trafficOutMbps)}</strong></div><div class="kv"><span>Alerts</span><strong>${d.alerts || 0}</strong></div><h3>Top Interfaces</h3><div class="list">${ports.map(portCard).join("") || `<p class="empty">No interfaces found for this device.</p>`}</div><h3>Connected Links</h3><div class="list">${links.map(linkCard).join("") || `<p class="empty">No links found for this device.</p>`}</div>`; }
function showLink(l) { const src = topology.devices.find(d => d.id === l.source), dst = topology.devices.find(d => d.id === l.target); els.panelTitle.textContent = `${src?.label || l.source} -> ${dst?.label || l.target}`; els.panelSub.textContent = `${l.localPortName || "port"} -> ${l.remotePortName || "port"}`; setPill(fmtPct(l.utilPct), Number(l.utilPct) >= 75 ? "warn" : "good"); els.panelBody.innerHTML = `<div class="kv"><span>Protocol</span><strong>${esc(l.protocol || "discovered")}</strong></div><div class="kv"><span>Local</span><strong>${esc(l.localDeviceLabel || src?.label || l.source)} | ${esc(l.localPortName || "port")}</strong></div><div class="kv"><span>Remote</span><strong>${esc(l.remoteDeviceLabel || dst?.label || l.target)} | ${esc(l.remotePortName || "port")}</strong></div><div class="kv"><span>Inbound</span><strong>${fmtMbps(l.inMbps)}</strong></div><div class="kv"><span>Outbound</span><strong>${fmtMbps(l.outMbps)}</strong></div><div class="kv"><span>Utilization</span><strong>${fmtPct(l.utilPct)}</strong></div><div class="kv"><span>Speed</span><strong>${esc(l.speedLabel || "-")}</strong></div><div class="kv"><span>Errors/sec</span><strong>In ${Number(l.inErrorsRate || 0)} / Out ${Number(l.outErrorsRate || 0)}</strong></div><div class="kv"><span>Discards/sec</span><strong>In ${Number(l.inDiscardsRate || 0)} / Out ${Number(l.outDiscardsRate || 0)}</strong></div><div class="item"><div class="item-title"><span>Utilization</span><span>${fmtPct(l.utilPct)}</span></div><div class="bar"><i style="--w:${Math.min(Number(l.utilPct || 0), 100)}%; background:${colorByUtil(l.utilPct)}"></i></div></div>`; }
function linkCard(l) { const src = topology.devices.find(d => d.id === l.source), dst = topology.devices.find(d => d.id === l.target); return `<div class="item"><div class="item-title"><span>${esc(src?.label || l.localDeviceLabel || l.source)} -> ${esc(dst?.label || l.remoteDeviceLabel || l.target)}</span><span>${fmtPct(l.utilPct)}</span></div><div class="item-sub">${esc(l.localPortName || "port")} -> ${esc(l.remotePortName || "port")} | ${esc(l.speedLabel || "")} | down ${fmtMbps(l.inMbps)} | up ${fmtMbps(l.outMbps)}</div><div class="bar"><i style="--w:${Math.min(Number(l.utilPct || 0), 100)}%; background:${colorByUtil(l.utilPct)}"></i></div></div>`; }
function portCard(p) { return `<div class="item"><div class="item-title"><span>${esc(p.device_label || p.device_id)} | ${esc(p.name)}</span><span>${fmtPct(p.utilPct)}</span></div><div class="item-sub">${esc(p.ifAlias || p.ifName || "")} | ${esc(p.ifOperStatus || "unknown")} | ${esc(p.speedLabel || "unknown")} | down ${fmtMbps(p.inMbps)} | up ${fmtMbps(p.outMbps)}</div><div class="bar"><i style="--w:${Math.min(Number(p.utilPct || 0), 100)}%; background:${colorByUtil(p.utilPct)}"></i></div></div>`; }
function setActiveNav(view) { document.querySelectorAll(".nav-btn").forEach(btn => btn.classList.toggle("active", btn.dataset.view === view)); }
function renderActivePanel() { if (!topology) return; if (activeView === "overview") return showOverview(); if (activeView === "devices") return showDevices(); if (activeView === "interfaces") return showInterfaces(); if (activeView === "links") return showLinks(); if (activeView === "alerts") return showAlerts(); if (activeView === "settings") return showSettings(); return showMapPanel(); }
function filterMap(query) { if (!cy) return; const q = query.trim().toLowerCase(); cy.elements().removeClass("faded"); if (!q) return; cy.elements().addClass("faded"); cy.nodes().forEach(node => { const raw = node.data("raw") || {}; if (JSON.stringify(raw).toLowerCase().includes(q)) { node.removeClass("faded"); node.connectedEdges().removeClass("faded"); node.connectedEdges().connectedNodes().removeClass("faded"); } }); }
function applyRoleFilter() { if (!cy) return; const role = els.roleFilter.value; cy.elements().removeClass("hiddenByFilter"); if (!role) return; cy.nodes().forEach(node => { if (node.data("role") !== role) node.addClass("hiddenByFilter"); }); }
function scheduleRefresh() { clearInterval(refreshTimer); refreshTimer = setInterval(loadTopology, Number(els.refreshInterval.value || 30000)); }

document.querySelectorAll(".nav-btn").forEach(btn => btn.addEventListener("click", () => { activeView = btn.dataset.view; setActiveNav(activeView); cy?.elements().removeClass("faded"); renderActivePanel(); }));
els.refreshBtn.addEventListener("click", () => loadTopology());
els.fitBtn.addEventListener("click", () => cy?.fit(undefined, 76));
els.resetBtn.addEventListener("click", clearPositions);
els.refreshInterval.addEventListener("change", scheduleRefresh);
els.searchBox.addEventListener("input", e => filterMap(e.target.value));
els.roleFilter.addEventListener("change", applyRoleFilter);

initCy();
loadTopology();
scheduleRefresh();
