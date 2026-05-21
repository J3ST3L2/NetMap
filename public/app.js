let cy;
let topology = null;
let refreshTimer = null;
let dashOffset = 0;
let activeView = "map";

const els = {
  title: document.getElementById("title"),
  subtitle: document.getElementById("subtitle"),
  modeBadge: document.getElementById("modeBadge"),
  sourceBadge: document.getElementById("sourceBadge"),
  searchBox: document.getElementById("searchBox"),
  refreshInterval: document.getElementById("refreshInterval"),
  refreshBtn: document.getElementById("refreshBtn"),
  fitBtn: document.getElementById("fitBtn"),
  resetBtn: document.getElementById("resetBtn"),
  lastUpdated: document.getElementById("lastUpdated"),
  panelTitle: document.getElementById("panelTitle"),
  panelSub: document.getElementById("panelSub"),
  panelStatus: document.getElementById("panelStatus"),
  panelBody: document.getElementById("panelBody"),
  toast: document.getElementById("toast")
};

function fmtMbps(value) {
  const n = Number(value || 0);
  if (n >= 1000) return `${(n / 1000).toFixed(2)} Gbps`;
  if (n >= 100) return `${n.toFixed(0)} Mbps`;
  if (n >= 10) return `${n.toFixed(1)} Mbps`;
  return `${n.toFixed(2)} Mbps`;
}

function fmtPct(value) {
  const n = Number(value || 0);
  if (n >= 100) return `${n.toFixed(0)}%`;
  if (n >= 10) return `${n.toFixed(1)}%`;
  return `${n.toFixed(2)}%`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function colorByUtil(util) {
  const u = Number(util || 0);
  if (u >= 100) return "#ff4d5a";
  if (u >= 75) return "#ff8f2a";
  if (u >= 50) return "#ffca3a";
  if (u >= 25) return "#c7df42";
  return "#48d16f";
}

function colorByRole(device) {
  if (device.status !== "up") return "#ff4d5a";
  if (device.alerts > 0) return "#ffca3a";
  if (device.role === "edge") return "#35e3ff";
  if (device.role === "firewall") return "#38a8ff";
  if (device.role === "core") return "#48d16f";
  if (device.role === "switch") return "#c7df42";
  if (device.role === "server") return "#a78bfa";
  return "#8fa9c1";
}

function iconByRole(role) {
  const map = {
    edge: "EDGE",
    firewall: "FW",
    core: "CORE",
    switch: "SW",
    server: "SRV",
    network: "NET"
  };
  return map[role] || "NET";
}

function showToast(message, timeout = 4500) {
  els.toast.textContent = message;
  els.toast.classList.remove("hidden");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => els.toast.classList.add("hidden"), timeout);
}

function savedPositions() {
  try {
    return JSON.parse(localStorage.getItem("netmap.positions.v2") || "{}");
  } catch {
    return {};
  }
}

function savePositions() {
  if (!cy) return;
  const out = {};
  cy.nodes().forEach(node => {
    out[node.id()] = node.position();
  });
  localStorage.setItem("netmap.positions.v2", JSON.stringify(out));
}

function clearPositions() {
  localStorage.removeItem("netmap.positions.v2");
  renderTopology(true);
  showToast("Saved layout cleared.");
}

function rank(device) {
  const ranks = { edge: 0, core: 1, switch: 2, firewall: 3, server: 4, network: 5 };
  return ranks[device.role] ?? 9;
}

function guessedPositions(devices) {
  const el = document.getElementById("cy");
  const width = Math.max(el.clientWidth, 1000);
  const center = width / 2;
  const positions = {};

  const byRole = role => devices
    .filter(d => d.role === role)
    .sort((a, b) => a.label.localeCompare(b.label));

  const edges = byRole("edge");
  const cores = byRole("core");
  const switches = [...byRole("switch"), ...byRole("network")];
  const firewalls = byRole("firewall");
  const servers = byRole("server");

  function place(items, y, spacing, xCenter = center) {
    const count = Math.max(items.length, 1);
    items.forEach((d, i) => {
      positions[d.id] = {
        x: xCenter + (i - (count - 1) / 2) * spacing,
        y
      };
    });
  }

  place(edges, 130, 280);
  place(cores, 285, 320);
  place(switches, 455, 250, center - 130);
  place(firewalls, 455, 280, center + 340);
  place(servers, 635, 210, center + 340);

  let idx = 0;
  const sorted = [...devices].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
  for (const d of sorted) {
    if (!positions[d.id]) {
      positions[d.id] = { x: 160 + (idx % 5) * 210, y: 780 + Math.floor(idx / 5) * 140 };
      idx++;
    }
  }

  return positions;
}

function buildElements(data, forceAuto = false) {
  const saved = forceAuto ? {} : savedPositions();
  const guessed = guessedPositions(data.devices);

  const nodes = data.devices.map(device => ({
    data: {
      id: device.id,
      label: device.label,
      role: device.role,
      badge: iconByRole(device.role),
      subtitle: device.ip || device.hostname || "",
      color: colorByRole(device),
      status: device.status,
      alerts: device.alerts || 0,
      raw: device
    },
    position: saved[device.id] || guessed[device.id]
  }));

  const edges = data.links.map(link => {
    const util = Number(link.utilPct || 0);
    const traffic = Math.max(Number(link.inMbps || 0), Number(link.outMbps || 0));
    return {
      data: {
        id: link.id,
        source: link.source,
        target: link.target,
        label: `${fmtMbps(link.inMbps)} down / ${fmtMbps(link.outMbps)} up`,
        color: colorByUtil(util),
        width: Math.max(2, Math.min(13, 2 + Math.sqrt(Math.max(traffic, 1)) / 3.5)),
        util,
        raw: link
      }
    };
  });

  return [...nodes, ...edges];
}

function initCy() {
  cy = cytoscape({
    container: document.getElementById("cy"),
    elements: [],
    layout: { name: "preset" },
    wheelSensitivity: 0.16,
    minZoom: 0.25,
    maxZoom: 2.2,
    style: [
      {
        selector: "node",
        style: {
          "shape": "round-rectangle",
          "width": 132,
          "height": 68,
          "background-color": "data(color)",
          "background-opacity": 0.13,
          "border-color": "data(color)",
          "border-width": 2,
          "border-opacity": 0.95,
          "label": ele => `${ele.data("badge")}  ${ele.data("label")}\n${ele.data("subtitle")}`,
          "text-wrap": "wrap",
          "text-max-width": 152,
          "text-valign": "center",
          "text-halign": "center",
          "font-size": 11,
          "font-weight": 750,
          "color": "#eef7ff",
          "text-outline-width": 2,
          "text-outline-color": "#06101c",
          "shadow-blur": 20,
          "shadow-color": "data(color)",
          "shadow-opacity": 0.30,
          "shadow-offset-x": 0,
          "shadow-offset-y": 0
        }
      },
      {
        selector: 'node[status = "down"]',
        style: {
          "border-style": "dashed",
          "background-opacity": 0.07
        }
      },
      {
        selector: 'node[alerts > 0]',
        style: {
          "border-width": 3
        }
      },
      {
        selector: "edge",
        style: {
          "curve-style": "bezier",
          "width": "data(width)",
          "line-color": "data(color)",
          "target-arrow-color": "data(color)",
          "source-arrow-color": "data(color)",
          "target-arrow-shape": "triangle",
          "source-arrow-shape": "triangle",
          "arrow-scale": .7,
          "opacity": .88,
          "label": "data(label)",
          "font-size": 10,
          "color": "#dceeff",
          "text-outline-color": "#06101c",
          "text-outline-width": 3,
          "text-background-color": "#06101c",
          "text-background-opacity": .62,
          "text-background-padding": 4,
          "line-style": "dashed",
          "line-dash-pattern": [12, 9],
          "line-dash-offset": 0
        }
      },
      {
        selector: ":selected",
        style: {
          "border-color": "#ffffff",
          "line-color": "#ffffff",
          "target-arrow-color": "#ffffff",
          "source-arrow-color": "#ffffff"
        }
      },
      {
        selector: ".faded",
        style: {
          "opacity": .12
        }
      }
    ]
  });

  cy.on("dragfree", "node", savePositions);

  cy.on("tap", "node", event => {
    activeView = "map";
    setActiveNav("map");
    focusNeighborhood(event.target);
    showDevice(event.target.data("raw"));
  });

  cy.on("tap", "edge", event => {
    activeView = "map";
    setActiveNav("map");
    showLink(event.target.data("raw"));
  });

  cy.on("tap", event => {
    if (event.target === cy) {
      cy.elements().removeClass("faded");
      if (activeView === "map") showMapPanel();
    }
  });

  setInterval(() => {
    if (!cy) return;
    dashOffset = (dashOffset - 1) % 22;
    cy.edges().style("line-dash-offset", dashOffset);
  }, 80);
}

function focusNeighborhood(node) {
  cy.elements().addClass("faded");
  node.removeClass("faded");
  node.connectedEdges().removeClass("faded");
  node.connectedEdges().connectedNodes().removeClass("faded");
}

function renderTopology(forceAuto = false) {
  if (!topology || !cy) return;
  cy.elements().remove();
  cy.add(buildElements(topology, forceAuto));
  cy.layout({ name: "preset", fit: true, padding: 74 }).run();
  cy.fit(undefined, 74);
  updateSummary();
  renderActivePanel();
}

function updateSummary() {
  const data = topology;
  const s = data.summary || {};
  const totalTraffic = Number(s.totalInMbps || 0) + Number(s.totalOutMbps || 0);

  els.title.textContent = data.title || "NetMap";
  els.subtitle.textContent = data.subtitle || "LibreNMS topology dashboard";

  els.modeBadge.textContent = data.mode || "live";
  els.modeBadge.className = data.mode === "mock" ? "mock" : "live";
  els.sourceBadge.textContent = data.mode === "mock" ? "Demo data" : "LibreNMS";

  document.getElementById("kpiDevices").textContent = s.totalDevices || 0;
  document.getElementById("kpiDevicesSub").textContent = `${s.upDevices || 0} up / ${s.downDevices || 0} down`;
  document.getElementById("kpiLinks").textContent = s.totalLinks || 0;
  document.getElementById("kpiTraffic").textContent = fmtMbps(totalTraffic);
  document.getElementById("kpiTrafficSub").textContent = `↓ ${fmtMbps(s.totalInMbps)} / ↑ ${fmtMbps(s.totalOutMbps)}`;
  document.getElementById("kpiAlerts").textContent = s.activeAlerts || 0;

  document.getElementById("railUp").textContent = `${s.upDevices || 0} up`;
  document.getElementById("railDown").textContent = `${s.downDevices || 0} down`;
  document.getElementById("railAlerts").textContent = `${s.activeAlerts || 0} alerts`;
  document.getElementById("railTraffic").textContent = fmtMbps(totalTraffic);
  document.getElementById("railIn").textContent = `↓ ${fmtMbps(s.totalInMbps)}`;
  document.getElementById("railOut").textContent = `↑ ${fmtMbps(s.totalOutMbps)}`;
  document.getElementById("navAlerts").textContent = s.activeAlerts || 0;

  els.lastUpdated.textContent = `Updated ${new Date(data.generatedAt).toLocaleTimeString()}`;

  const warnings = Object.values(data.warnings || {}).filter(Boolean);
  if (warnings.length) showToast(warnings[0]);
}

async function loadTopology({ forceAuto = false } = {}) {
  els.refreshBtn.disabled = true;
  els.refreshBtn.textContent = "Loading...";
  try {
    const res = await fetch("/api/topology", { cache: "no-store" });
    const data = await res.json();
    if (!res.ok || data.status !== "ok") throw new Error(data.message || "Topology fetch failed.");
    topology = data;
    renderTopology(forceAuto);
  } catch (err) {
    showToast(err.message || String(err), 8000);
  } finally {
    els.refreshBtn.disabled = false;
    els.refreshBtn.textContent = "Refresh";
  }
}

function setPill(text, kind = "neutral") {
  els.panelStatus.textContent = text;
  els.panelStatus.className = `pill ${kind}`;
}

function showMapPanel() {
  els.panelTitle.textContent = "Map";
  els.panelSub.textContent = "Click a node or link to inspect it.";
  setPill("ready");
  els.panelBody.innerHTML = `
    <p class="empty">This map is built from LibreNMS devices, links, ports, and alerts. Drag nodes to adjust the layout; your browser saves the positions.</p>
    <div class="kv"><span>Layout</span><strong>UXG edge -> core/switching -> Sophos -> servers</strong></div>
    <div class="kv"><span>Traffic</span><strong>Animated from port counters</strong></div>
    <div class="kv"><span>Refresh</span><strong>${Number(els.refreshInterval.value) / 1000}s</strong></div>
  `;
}

function showOverview() {
  const s = topology.summary;
  const busiest = [...topology.links].sort((a, b) => Math.max(b.inMbps, b.outMbps) - Math.max(a.inMbps, a.outMbps)).slice(0, 5);
  els.panelTitle.textContent = "Overview";
  els.panelSub.textContent = "Network health and busiest links.";
  setPill(topology.mode, topology.mode === "mock" ? "warn" : "good");
  els.panelBody.innerHTML = `
    <div class="kv"><span>Devices</span><strong>${s.totalDevices}</strong></div>
    <div class="kv"><span>Links</span><strong>${s.totalLinks}</strong></div>
    <div class="kv"><span>Traffic</span><strong>${fmtMbps(s.totalInMbps + s.totalOutMbps)}</strong></div>
    <div class="kv"><span>Alerts</span><strong>${s.activeAlerts}</strong></div>
    <h3>Busiest Links</h3>
    <div class="list">
      ${busiest.map(linkCard).join("") || `<p class="empty">No links found.</p>`}
    </div>
  `;
}

function showDevices() {
  const devices = [...topology.devices].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
  els.panelTitle.textContent = "Devices";
  els.panelSub.textContent = `${devices.length} monitored devices.`;
  setPill("inventory");
  els.panelBody.innerHTML = `
    <div class="list">
      ${devices.map(d => `
        <div class="item clickable" data-node="${escapeHtml(d.id)}">
          <div class="item-title"><span>${escapeHtml(d.label)}</span><span>${escapeHtml(d.role)}</span></div>
          <div class="item-sub">${escapeHtml(d.ip || d.hostname || "No IP")} · ${escapeHtml(d.status)} · ${d.alerts || 0} alerts</div>
        </div>
      `).join("")}
    </div>
  `;
  els.panelBody.querySelectorAll("[data-node]").forEach(el => {
    el.addEventListener("click", () => {
      const node = cy.getElementById(el.dataset.node);
      if (node.length) {
        cy.animate({ center: { eles: node }, zoom: 1.05 }, { duration: 300 });
        node.select();
        focusNeighborhood(node);
        showDevice(node.data("raw"));
      }
    });
  });
}

function showLinks() {
  const links = [...topology.links].sort((a, b) => Number(b.utilPct || 0) - Number(a.utilPct || 0));
  els.panelTitle.textContent = "Links";
  els.panelSub.textContent = `${links.length} discovered topology links.`;
  setPill("traffic");
  els.panelBody.innerHTML = `<div class="list">${links.map(linkCard).join("") || `<p class="empty">No discovered links found.</p>`}</div>`;
}

function showAlerts() {
  const alerts = topology.alerts || [];
  els.panelTitle.textContent = "Alerts";
  els.panelSub.textContent = `${alerts.length} active alert records.`;
  setPill(alerts.length ? "active" : "clear", alerts.length ? "warn" : "good");
  els.panelBody.innerHTML = `
    <div class="list">
      ${alerts.map(a => `
        <div class="item">
          <div class="item-title"><span>${escapeHtml(a.title || a.rule || a.name || "Alert")}</span><span>${escapeHtml(a.severity || a.state || "active")}</span></div>
          <div class="item-sub">${escapeHtml(a.hostname || a.device || a.device_id || "")} · ${escapeHtml(a.timestamp || a.time_logged || "")}</div>
        </div>
      `).join("") || `<p class="empty">No active alerts returned.</p>`}
    </div>
  `;
}

function showSettings() {
  els.panelTitle.textContent = "Settings";
  els.panelSub.textContent = "Runtime settings live in the server .env file.";
  setPill("config");
  els.panelBody.innerHTML = `
    <div class="kv"><span>Mode</span><strong>${escapeHtml(topology.mode)}</strong></div>
    <div class="kv"><span>Source</span><strong>${escapeHtml(topology.source)}</strong></div>
    <div class="kv"><span>Mock mode</span><strong>Set MOCK_MODE=true/false/auto</strong></div>
    <div class="kv"><span>Layout</span><strong>Saved in browser local storage</strong></div>
    <p class="empty">To test without LibreNMS, set MOCK_MODE=true in .env and rebuild the container.</p>
  `;
}

function statusKind(device) {
  if (device.status !== "up") return "bad";
  if ((device.alerts || 0) > 0) return "warn";
  return "good";
}

function showDevice(device) {
  els.panelTitle.textContent = device.label;
  els.panelSub.textContent = `${device.role.toUpperCase()} · ${device.ip || device.hostname || "No IP"}`;
  setPill(device.status, statusKind(device));

  const links = topology.links.filter(l => l.source === device.id || l.target === device.id);
  els.panelBody.innerHTML = `
    <div class="kv"><span>Hostname</span><strong>${escapeHtml(device.hostname || device.sysName || "—")}</strong></div>
    <div class="kv"><span>IP</span><strong>${escapeHtml(device.ip || "—")}</strong></div>
    <div class="kv"><span>OS</span><strong>${escapeHtml(device.os || "—")}</strong></div>
    <div class="kv"><span>Hardware</span><strong>${escapeHtml(device.hardware || "—")}</strong></div>
    <div class="kv"><span>Location</span><strong>${escapeHtml(device.location || "—")}</strong></div>
    <div class="kv"><span>Links</span><strong>${links.length}</strong></div>
    <div class="kv"><span>Alerts</span><strong>${device.alerts || 0}</strong></div>
    <h3>Connected Links</h3>
    <div class="list">${links.map(linkCard).join("") || `<p class="empty">No links found for this device.</p>`}</div>
  `;
}

function showLink(link) {
  const src = topology.devices.find(d => d.id === link.source);
  const dst = topology.devices.find(d => d.id === link.target);
  els.panelTitle.textContent = `${src?.label || link.source} ⇄ ${dst?.label || link.target}`;
  els.panelSub.textContent = `${link.localPortName || "port"} ⇄ ${link.remotePortName || "port"}`;
  setPill(fmtPct(link.utilPct), Number(link.utilPct) >= 75 ? "warn" : "good");

  els.panelBody.innerHTML = `
    <div class="kv"><span>Protocol</span><strong>${escapeHtml(link.protocol || "discovered")}</strong></div>
    <div class="kv"><span>Inbound</span><strong>${fmtMbps(link.inMbps)}</strong></div>
    <div class="kv"><span>Outbound</span><strong>${fmtMbps(link.outMbps)}</strong></div>
    <div class="kv"><span>Utilization</span><strong>${fmtPct(link.utilPct)}</strong></div>
    <div class="kv"><span>Speed</span><strong>${link.speedBps ? fmtMbps(link.speedBps / 1000 / 1000) : "—"}</strong></div>
    <div class="kv"><span>Errors/sec</span><strong>In ${Number(link.inErrorsRate || 0)} / Out ${Number(link.outErrorsRate || 0)}</strong></div>
    <div class="item">
      <div class="item-title"><span>Utilization</span><span>${fmtPct(link.utilPct)}</span></div>
      <div class="bar"><i style="--w:${Math.min(Number(link.utilPct || 0), 100)}%; background:${colorByUtil(link.utilPct)}"></i></div>
    </div>
  `;
}

function linkCard(link) {
  const src = topology.devices.find(d => d.id === link.source);
  const dst = topology.devices.find(d => d.id === link.target);
  return `
    <div class="item">
      <div class="item-title">
        <span>${escapeHtml(src?.label || link.source)} ⇄ ${escapeHtml(dst?.label || link.target)}</span>
        <span>${fmtPct(link.utilPct)}</span>
      </div>
      <div class="item-sub">${escapeHtml(link.localPortName || "port")} ⇄ ${escapeHtml(link.remotePortName || "port")} · ↓ ${fmtMbps(link.inMbps)} · ↑ ${fmtMbps(link.outMbps)}</div>
      <div class="bar"><i style="--w:${Math.min(Number(link.utilPct || 0), 100)}%; background:${colorByUtil(link.utilPct)}"></i></div>
    </div>
  `;
}

function setActiveNav(view) {
  document.querySelectorAll(".nav-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });
}

function renderActivePanel() {
  if (!topology) return;
  if (activeView === "overview") return showOverview();
  if (activeView === "devices") return showDevices();
  if (activeView === "links") return showLinks();
  if (activeView === "alerts") return showAlerts();
  if (activeView === "settings") return showSettings();
  return showMapPanel();
}

function filterMap(query) {
  if (!cy) return;
  const q = query.trim().toLowerCase();
  cy.elements().removeClass("faded");
  if (!q) return;

  cy.elements().addClass("faded");
  cy.nodes().forEach(node => {
    const raw = node.data("raw") || {};
    const text = JSON.stringify(raw).toLowerCase();
    if (text.includes(q)) {
      node.removeClass("faded");
      node.connectedEdges().removeClass("faded");
      node.connectedEdges().connectedNodes().removeClass("faded");
    }
  });
}

function scheduleRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(loadTopology, Number(els.refreshInterval.value || 30000));
}

document.querySelectorAll(".nav-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    activeView = btn.dataset.view;
    setActiveNav(activeView);
    cy?.elements().removeClass("faded");
    renderActivePanel();
  });
});

els.refreshBtn.addEventListener("click", () => loadTopology());
els.fitBtn.addEventListener("click", () => cy?.fit(undefined, 76));
els.resetBtn.addEventListener("click", clearPositions);
els.refreshInterval.addEventListener("change", scheduleRefresh);
els.searchBox.addEventListener("input", e => filterMap(e.target.value));

initCy();
loadTopology();
scheduleRefresh();
