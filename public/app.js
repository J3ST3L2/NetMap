let cy;
let topology = null;
let refreshTimer = null;
let dashOffset = 0;

const els = {
  sourceLabel: document.getElementById("sourceLabel"),
  lastUpdated: document.getElementById("lastUpdated"),
  refreshBtn: document.getElementById("refreshBtn"),
  autoLayoutBtn: document.getElementById("autoLayoutBtn"),
  clearLayoutBtn: document.getElementById("clearLayoutBtn"),
  refreshInterval: document.getElementById("refreshInterval"),
  searchBox: document.getElementById("searchBox"),
  toast: document.getElementById("toast"),
  detailsTitle: document.getElementById("detailsTitle"),
  detailsSub: document.getElementById("detailsSub"),
  detailsStatus: document.getElementById("detailsStatus"),
  detailsBody: document.getElementById("detailsBody")
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

function edgeColor(util) {
  if (util >= 100) return "#ff4c4c";
  if (util >= 75) return "#ff8b2b";
  if (util >= 50) return "#ffc241";
  if (util >= 25) return "#a8de39";
  return "#52d866";
}

function nodeColor(device) {
  if (device.status !== "up") return "#ff4c4c";
  if (device.alerts > 0) return "#ffc241";
  if (device.role === "edge") return "#35e3ff";
  if (device.role === "firewall") return "#3a7cff";
  if (device.role === "core") return "#52d866";
  if (device.role === "server") return "#a6b8ca";
  return "#3aa7ff";
}

function iconForRole(role) {
  if (role === "edge") return "◎";
  if (role === "firewall") return "盾";
  if (role === "core") return "▣";
  if (role === "switch") return "▤";
  if (role === "server") return "▥";
  return "◆";
}

function showToast(message, timeout = 4200) {
  els.toast.textContent = message;
  els.toast.classList.remove("hidden");
  window.clearTimeout(showToast._timer);
  showToast._timer = window.setTimeout(() => els.toast.classList.add("hidden"), timeout);
}

function savedPositions() {
  try {
    return JSON.parse(localStorage.getItem("librenms-netmap-positions") || "{}");
  } catch {
    return {};
  }
}

function savePositions() {
  if (!cy) return;
  const positions = {};
  cy.nodes().forEach(node => {
    positions[node.id()] = node.position();
  });
  localStorage.setItem("librenms-netmap-positions", JSON.stringify(positions));
}

function clearPositions() {
  localStorage.removeItem("librenms-netmap-positions");
  renderTopology(true);
}

function deviceSortRank(device) {
  const ranks = { edge: 0, core: 1, switch: 2, firewall: 3, server: 4, network: 5 };
  return ranks[device.role] ?? 9;
}

function guessPositions(devices) {
  const width = Math.max(document.getElementById("cy").clientWidth, 900);
  const center = width / 2;
  const positions = {};

  const sorted = [...devices].sort((a, b) => deviceSortRank(a) - deviceSortRank(b) || a.label.localeCompare(b.label));
  const edge = sorted.filter(d => d.role === "edge");
  const core = sorted.filter(d => d.role === "core");
  const switches = sorted.filter(d => d.role === "switch" || d.role === "network");
  const firewalls = sorted.filter(d => d.role === "firewall");
  const servers = sorted.filter(d => d.role === "server");

  const placeRow = (items, y, spread) => {
    const count = Math.max(items.length, 1);
    items.forEach((d, i) => {
      const x = center + (i - (count - 1) / 2) * spread;
      positions[d.id] = { x, y };
    });
  };

  placeRow(edge, 130, 240);
  placeRow(core, 280, 260);

  if (switches.length <= 2) {
    placeRow(switches, 430, 520);
  } else {
    placeRow(switches, 430, 260);
  }

  placeRow(firewalls, 470, 260);
  placeRow(servers, 620, 220);

  let extraIndex = 0;
  for (const d of sorted) {
    if (!positions[d.id]) {
      positions[d.id] = {
        x: 120 + (extraIndex % 5) * 220,
        y: 760 + Math.floor(extraIndex / 5) * 140
      };
      extraIndex += 1;
    }
  }

  return positions;
}

function buildElements(data, forceAuto = false) {
  const saved = forceAuto ? {} : savedPositions();
  const guessed = guessPositions(data.devices);

  const nodes = data.devices.map(device => ({
    data: {
      id: device.id,
      label: device.label,
      subtitle: device.ip || device.hostname || "",
      icon: iconForRole(device.role),
      color: nodeColor(device),
      role: device.role,
      status: device.status,
      alerts: device.alerts,
      raw: device
    },
    position: saved[device.id] || guessed[device.id]
  }));

  const edges = data.links.map(link => {
    const util = Number(link.utilPct || 0);
    return {
      data: {
        id: link.id,
        source: link.source,
        target: link.target,
        label: `↓ ${fmtMbps(link.inMbps)}  ↑ ${fmtMbps(link.outMbps)}`,
        color: edgeColor(util),
        width: Math.max(2, Math.min(12, 2 + Math.sqrt(Math.max(link.inMbps, link.outMbps, 1)) / 4)),
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
    wheelSensitivity: 0.18,
    style: [
      {
        selector: "node",
        style: {
          "shape": "round-rectangle",
          "width": 122,
          "height": 64,
          "background-color": "data(color)",
          "background-opacity": 0.17,
          "border-color": "data(color)",
          "border-width": 2,
          "border-opacity": 0.9,
          "label": ele => `${ele.data("icon")}  ${ele.data("label")}\n${ele.data("subtitle")}`,
          "text-wrap": "wrap",
          "text-max-width": 150,
          "text-valign": "center",
          "text-halign": "center",
          "font-size": 12,
          "font-weight": 700,
          "color": "#eef6ff",
          "text-outline-width": 2,
          "text-outline-color": "#071525",
          "shadow-blur": 18,
          "shadow-color": "data(color)",
          "shadow-opacity": 0.35,
          "shadow-offset-x": 0,
          "shadow-offset-y": 0
        }
      },
      {
        selector: 'node[status = "down"]',
        style: {
          "border-style": "dashed",
          "background-opacity": 0.09
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
          "arrow-scale": 0.75,
          "opacity": 0.88,
          "label": "data(label)",
          "font-size": 11,
          "color": "#d8e9ff",
          "text-outline-color": "#071525",
          "text-outline-width": 3,
          "text-background-color": "#06111d",
          "text-background-opacity": 0.68,
          "text-background-padding": 4,
          "line-style": "dashed",
          "line-dash-pattern": [10, 8],
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
          "opacity": 0.13
        }
      }
    ]
  });

  cy.on("dragfree", "node", savePositions);

  cy.on("tap", "node", event => showDeviceDetails(event.target.data("raw")));
  cy.on("tap", "edge", event => showLinkDetails(event.target.data("raw")));

  cy.on("tap", event => {
    if (event.target === cy) {
      clearSelectionDetails();
      cy.elements().removeClass("faded");
    }
  });

  cy.on("mouseover", "node", event => {
    const node = event.target;
    cy.elements().addClass("faded");
    node.removeClass("faded");
    node.connectedEdges().removeClass("faded");
    node.connectedEdges().connectedNodes().removeClass("faded");
  });

  cy.on("mouseout", "node", () => cy.elements().removeClass("faded"));

  setInterval(() => {
    if (!cy) return;
    dashOffset = (dashOffset - 1) % 18;
    cy.edges().style("line-dash-offset", dashOffset);
  }, 90);
}

function renderTopology(forceAuto = false) {
  if (!topology || !cy) return;
  cy.elements().remove();
  cy.add(buildElements(topology, forceAuto));
  cy.layout({ name: "preset", fit: true, padding: 70 }).run();
  cy.fit(undefined, 70);
  updateSummary(topology);
}

function updateSummary(data) {
  const s = data.summary || {};
  const totalMbps = Number(s.totalInMbps || 0) + Number(s.totalOutMbps || 0);

  document.getElementById("totalDevices").textContent = s.totalDevices || 0;
  document.getElementById("upDevices").textContent = s.upDevices || 0;
  document.getElementById("downDevices").textContent = s.downDevices || 0;
  document.getElementById("activeAlerts").textContent = s.activeAlerts || 0;
  document.getElementById("navAlertCount").textContent = s.activeAlerts || 0;
  document.getElementById("sumIn").textContent = fmtMbps(s.totalInMbps);
  document.getElementById("sumOut").textContent = fmtMbps(s.totalOutMbps);

  document.getElementById("metricBandwidth").textContent = fmtMbps(totalMbps);
  document.getElementById("metricBandwidthSub").textContent = `↓ ${fmtMbps(s.totalInMbps)}  ↑ ${fmtMbps(s.totalOutMbps)}`;
  document.getElementById("metricDevices").textContent = s.totalDevices || 0;
  document.getElementById("metricDevicesSub").textContent = `${s.upDevices || 0} up / ${s.downDevices || 0} down`;
  document.getElementById("metricLinks").textContent = s.totalLinks || 0;
  document.getElementById("metricAlerts").textContent = s.activeAlerts || 0;

  const up = Number(s.upDevices || 0);
  const down = Number(s.downDevices || 0);
  const total = Math.max(Number(s.totalDevices || 0), 1);
  const upDeg = Math.round(up / total * 360);
  const downDeg = Math.round((up + down) / total * 360);
  document.getElementById("deviceDonut").style.background =
    `conic-gradient(var(--green) 0deg, var(--green) ${upDeg}deg, var(--red) ${upDeg}deg, var(--red) ${downDeg}deg, var(--amber) ${downDeg}deg)`;

  els.sourceLabel.textContent = `Source: ${data.source}`;
  els.lastUpdated.textContent = `Updated ${new Date(data.generatedAt).toLocaleTimeString()}`;

  const warningValues = Object.values(data.warnings || {}).filter(Boolean);
  if (warningValues.length) {
    showToast(`Loaded topology with warning: ${warningValues[0]}`);
  }
}

async function loadTopology({ forceAuto = false } = {}) {
  els.refreshBtn.disabled = true;
  els.refreshBtn.textContent = "Loading…";
  try {
    const res = await fetch("/api/topology", { cache: "no-store" });
    const data = await res.json();
    if (!res.ok || data.status !== "ok") throw new Error(data.message || "Topology fetch failed.");
    topology = data;
    renderTopology(forceAuto);
  } catch (err) {
    showToast(err.message || String(err), 8000);
    els.sourceLabel.textContent = "LibreNMS API not reachable or not configured.";
  } finally {
    els.refreshBtn.disabled = false;
    els.refreshBtn.textContent = "Refresh";
  }
}

function statusClass(status, alerts = 0) {
  if (status !== "up") return "down";
  if (alerts > 0) return "warn";
  return "up";
}

function setStatusPill(text, cls) {
  els.detailsStatus.className = `status-pill ${cls}`;
  els.detailsStatus.textContent = text;
}

function showDeviceDetails(device) {
  setStatusPill(device.alerts > 0 ? `${device.alerts} Alert${device.alerts === 1 ? "" : "s"}` : device.status, statusClass(device.status, device.alerts));
  els.detailsTitle.textContent = device.label;
  els.detailsSub.textContent = `${device.role.toUpperCase()} • ${device.ip || device.hostname || "No IP"}`;

  const links = topology.links.filter(l => l.source === device.id || l.target === device.id);
  const topLinks = [...links].sort((a, b) => Number(b.utilPct || 0) - Number(a.utilPct || 0)).slice(0, 5);

  els.detailsBody.innerHTML = `
    <div class="kv"><span>Hostname</span><strong>${escapeHtml(device.hostname || device.sysName || "—")}</strong></div>
    <div class="kv"><span>IP Address</span><strong>${escapeHtml(device.ip || "—")}</strong></div>
    <div class="kv"><span>OS</span><strong>${escapeHtml(device.os || "—")}</strong></div>
    <div class="kv"><span>Hardware</span><strong>${escapeHtml(device.hardware || "—")}</strong></div>
    <div class="kv"><span>Location</span><strong>${escapeHtml(device.location || "—")}</strong></div>
    <div class="kv"><span>Links</span><strong>${links.length}</strong></div>
    <div class="kv"><span>Alerts</span><strong>${device.alerts || 0}</strong></div>

    <div class="port-list">
      ${topLinks.map(link => `
        <div class="port-item">
          <strong>${escapeHtml(link.localPortName)} ⇄ ${escapeHtml(link.remotePortName)}</strong>
          <div>↓ ${fmtMbps(link.inMbps)} &nbsp; ↑ ${fmtMbps(link.outMbps)} &nbsp; ${fmtPct(link.utilPct)}</div>
          <div class="bar"><i style="--w:${Math.min(Number(link.utilPct || 0), 100)}%; background:${edgeColor(Number(link.utilPct || 0))}"></i></div>
        </div>
      `).join("") || `<p class="empty">No discovered links found for this device.</p>`}
    </div>
  `;
}

function showLinkDetails(link) {
  setStatusPill(link.status, link.status === "up" ? "up" : "down");
  els.detailsTitle.textContent = `${link.localPortName} ⇄ ${link.remotePortName}`;
  els.detailsSub.textContent = `${link.protocol.toUpperCase()} • ${fmtPct(link.utilPct)} utilization`;

  const source = topology.devices.find(d => d.id === link.source);
  const target = topology.devices.find(d => d.id === link.target);

  els.detailsBody.innerHTML = `
    <div class="kv"><span>Source</span><strong>${escapeHtml(source?.label || link.source)}</strong></div>
    <div class="kv"><span>Target</span><strong>${escapeHtml(target?.label || link.target)}</strong></div>
    <div class="kv"><span>Local Port</span><strong>${escapeHtml(link.localPortName)}</strong></div>
    <div class="kv"><span>Remote Port</span><strong>${escapeHtml(link.remotePortName)}</strong></div>
    <div class="kv"><span>Inbound</span><strong>${fmtMbps(link.inMbps)}</strong></div>
    <div class="kv"><span>Outbound</span><strong>${fmtMbps(link.outMbps)}</strong></div>
    <div class="kv"><span>Utilization</span><strong>${fmtPct(link.utilPct)}</strong></div>
    <div class="kv"><span>Speed</span><strong>${link.speedBps ? fmtMbps(link.speedBps / 1000 / 1000) : "—"}</strong></div>
    <div class="kv"><span>Errors/sec</span><strong>In ${Number(link.inErrorsRate || 0)} / Out ${Number(link.outErrorsRate || 0)}</strong></div>
    <div class="port-list">
      <div class="port-item">
        <strong>Link Utilization</strong>
        <div class="bar"><i style="--w:${Math.min(Number(link.utilPct || 0), 100)}%; background:${edgeColor(Number(link.utilPct || 0))}"></i></div>
      </div>
    </div>
  `;
}

function clearSelectionDetails() {
  setStatusPill("Idle", "muted");
  els.detailsTitle.textContent = "Select a device or link";
  els.detailsSub.textContent = "Click anything on the map for details.";
  els.detailsBody.innerHTML = `<p class="empty">Topology will populate from LibreNMS devices, discovered links, and port counters.</p>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function filterMap(query) {
  if (!cy) return;
  const q = query.trim().toLowerCase();
  cy.elements().removeClass("faded");
  if (!q) return;

  cy.elements().addClass("faded");
  cy.nodes().forEach(node => {
    const raw = node.data("raw") || {};
    const haystack = JSON.stringify(raw).toLowerCase();
    if (haystack.includes(q)) {
      node.removeClass("faded");
      node.connectedEdges().removeClass("faded");
      node.connectedEdges().connectedNodes().removeClass("faded");
    }
  });
}

function scheduleRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  const ms = Number(els.refreshInterval.value || 30000);
  refreshTimer = setInterval(() => loadTopology(), ms);
}

els.refreshBtn.addEventListener("click", () => loadTopology());
els.autoLayoutBtn.addEventListener("click", () => renderTopology(true));
els.clearLayoutBtn.addEventListener("click", clearPositions);
els.refreshInterval.addEventListener("change", scheduleRefresh);
els.searchBox.addEventListener("input", e => filterMap(e.target.value));

document.querySelectorAll(".nav-item").forEach(button => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach(b => b.classList.remove("active"));
    button.classList.add("active");
    showToast(`${button.textContent.trim()} panel is a placeholder in this starter. The map is wired now; the other panels can be expanded next.`);
  });
});

initCy();
loadTopology();
scheduleRefresh();
