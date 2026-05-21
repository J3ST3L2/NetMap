/* NetMap endpoint search, top talkers, and ticker enhancements */

function netmapEnsureEnhancementNav() {
  const nav = document.querySelector(".nav");
  if (!nav) return;

  if (!document.querySelector('[data-view="search"]')) {
    const btn = document.createElement("button");
    btn.className = "nav-btn";
    btn.dataset.view = "search";
    btn.innerHTML = "<span>⌕</span><b>Search</b></button>";
    const links = document.querySelector('[data-view="links"]');
    nav.insertBefore(btn, links || null);
  }

  if (!document.querySelector('[data-view="talkers"]')) {
    const btn = document.createElement("button");
    btn.className = "nav-btn";
    btn.dataset.view = "talkers";
    btn.innerHTML = "<span>⇅</span><b>Talkers</b></button>";
    const alerts = document.querySelector('[data-view="alerts"]');
    nav.insertBefore(btn, alerts || null);
  }

  document.querySelectorAll(".nav-btn").forEach(btn => {
    if (btn.dataset.netmapEnhanced) return;
    btn.dataset.netmapEnhanced = "true";
    btn.addEventListener("click", () => {
      activeView = btn.dataset.view;
      setActiveNav(activeView);
      cy?.elements().removeClass("faded");
      renderActivePanel();
    });
  });
}

function netmapEnsureTicker() {
  if (document.getElementById("netmapTicker")) return;

  const ticker = document.createElement("div");
  ticker.id = "netmapTicker";
  ticker.className = "netmap-ticker";
  ticker.innerHTML = `
    <div class="ticker-label">EVENTS</div>
    <div class="ticker-track">
      <div id="netmapTickerItems" class="ticker-items">Loading NetMap events...</div>
    </div>
  `;
  document.body.appendChild(ticker);
}

async function netmapLoadTicker() {
  const target = document.getElementById("netmapTickerItems");
  if (!target) return;

  try {
    const res = await fetch("/api/ticker", { cache: "no-store" });
    const data = await res.json();

    if (!res.ok || data.status !== "ok") {
      target.textContent = "Ticker unavailable";
      return;
    }

    if (!data.items.length) {
      target.textContent = "No active alerts or notable topology events";
      return;
    }

    target.innerHTML = data.items.map(item => `
      <span class="ticker-item ${esc(item.severity || "info")}">
        <b>${esc(item.source || "NetMap")}</b>
        ${esc(item.message || "")}
      </span>
    `).join("");
  } catch {
    target.textContent = "Ticker unavailable";
  }
}

function showSearch() {
  els.panelTitle.textContent = "Endpoint Search";
  els.panelSub.textContent = "Find a client by IP, MAC, or CIDR using LibreNMS ARP and FDB tables.";
  setPill("ARP / MAC", "good");

  els.panelBody.innerHTML = `
    <div class="search-panel">
      <input id="endpointSearchInput" placeholder="IP, CIDR, or MAC address..." />
      <button id="endpointSearchBtn">Search</button>
    </div>

    <div class="quick-actions">
      <button data-example-search="10.20.20.1">Example IP</button>
      <button data-example-search="10.20.20.0/24">Example CIDR</button>
    </div>

    <p class="empty">
      Search checks ARP first, then follows MAC addresses into the FDB/MAC table
      to find switch, interface, VLAN, and last-seen details.
    </p>

    <div id="endpointSearchResults" class="list"></div>
  `;

  const input = document.getElementById("endpointSearchInput");
  const button = document.getElementById("endpointSearchBtn");

  const run = () => runEndpointSearch(input.value);
  button.addEventListener("click", run);
  input.addEventListener("keydown", event => {
    if (event.key === "Enter") run();
  });

  document.querySelectorAll("[data-example-search]").forEach(btn => {
    btn.addEventListener("click", () => {
      input.value = btn.dataset.exampleSearch;
      runEndpointSearch(input.value);
    });
  });

  input.focus();
}

async function runEndpointSearch(query) {
  const q = String(query || "").trim();
  const resultsEl = document.getElementById("endpointSearchResults");

  if (!q) {
    resultsEl.innerHTML = `<p class="empty">Enter an IP, CIDR, or MAC address.</p>`;
    return;
  }

  resultsEl.innerHTML = `<p class="empty">Searching LibreNMS ARP/FDB tables...</p>`;

  try {
    const res = await fetch(`/api/endpoint-search?q=${encodeURIComponent(q)}`, { cache: "no-store" });
    const data = await res.json();

    if (!res.ok || data.status !== "ok") {
      resultsEl.innerHTML = `<p class="empty">${esc(data.message || data.detail || "Search failed.")}</p>`;
      return;
    }

    if (!data.results.length) {
      resultsEl.innerHTML = `<p class="empty">No ARP/FDB entries found for ${esc(q)}.</p>`;
      return;
    }

    resultsEl.innerHTML = `
      <div class="search-summary">
        ${data.count} result${data.count === 1 ? "" : "s"} for <strong>${esc(data.query)}</strong>
      </div>

      <div class="table search-table">
        <div class="table-row header">
          <span>Source</span><span>IP</span><span>MAC</span><span>Device</span><span>Port</span><span>VLAN</span><span>Last seen</span>
        </div>

        ${data.results.map(r => `
          <div class="table-row item">
            <span>${esc(r.source || "—")}</span>
            <strong>${esc(r.ip || "—")}</strong>
            <span>${esc(r.mac || "—")}</span>
            <span>${esc(r.deviceLabel || r.hostname || r.device || "—")}</span>
            <span title="${esc(r.portAlias || "")}">${esc(r.port || "—")}${r.speed ? ` · ${esc(r.speed)}` : ""}</span>
            <span>${esc(r.vlan || "—")}</span>
            <span>${esc(r.lastSeen || r.updatedAt || "—")}</span>
          </div>
        `).join("")}
      </div>

      <h3>Best Location Guess</h3>
      ${data.location ? `
        <div class="item">
          <div class="item-title">
            <span>${esc(data.location.deviceLabel || data.location.device || "Unknown device")}</span>
            <span>${esc(data.location.confidence || "possible")}</span>
          </div>
          <div class="item-sub">
            ${esc(data.location.port || "Unknown port")}
            ${data.location.vlan ? ` · VLAN ${esc(data.location.vlan)}` : ""}
            ${data.location.lastSeen ? ` · last seen ${esc(data.location.lastSeen)}` : ""}
          </div>
        </div>
      ` : `<p class="empty">No confident switch-port location found.</p>`}
    `;
  } catch (err) {
    resultsEl.innerHTML = `<p class="empty">Search failed: ${esc(err.message || String(err))}</p>`;
  }
}

function showTalkers() {
  els.panelTitle.textContent = "Top Talkers";
  els.panelSub.textContent = "Busiest devices, interfaces, and discovered links from the latest LibreNMS data.";
  setPill("traffic", "good");

  els.panelBody.innerHTML = `<p class="empty">Loading top talkers...</p>`;

  fetch("/api/top-talkers", { cache: "no-store" })
    .then(r => r.json())
    .then(data => {
      if (data.status !== "ok") {
        els.panelBody.innerHTML = `<p class="empty">${esc(data.message || "Could not load top talkers.")}</p>`;
        return;
      }

      els.panelBody.innerHTML = `
        <h3>Devices</h3>
        <div class="list">
          ${data.devices.map(d => `
            <div class="item">
              <div class="item-title"><span>${esc(d.label)}</span><span>${fmtMbps(d.totalMbps)}</span></div>
              <div class="item-sub">${esc(d.role || "")} · ${esc(d.vendor || "")} · down ${fmtMbps(d.inMbps)} / up ${fmtMbps(d.outMbps)}</div>
              <div class="bar"><i style="--w:${Math.min(d.utilPct || 0, 100)}%; background:${colorByUtil(d.utilPct || 0)}"></i></div>
            </div>
          `).join("") || `<p class="empty">No device traffic yet.</p>`}
        </div>

        <h3>Interfaces</h3>
        <div class="list">
          ${data.interfaces.map(p => `
            <div class="item">
              <div class="item-title"><span>${esc(p.deviceLabel)} · ${esc(p.name)}</span><span>${esc(p.speed || "unknown")}</span></div>
              <div class="item-sub">${esc(p.alias || "")} · down ${fmtMbps(p.inMbps)} / up ${fmtMbps(p.outMbps)} · ${fmtPct(p.utilPct)}</div>
              <div class="bar"><i style="--w:${Math.min(p.utilPct || 0, 100)}%; background:${colorByUtil(p.utilPct || 0)}"></i></div>
            </div>
          `).join("") || `<p class="empty">No interface traffic yet.</p>`}
        </div>

        <h3>Links</h3>
        <div class="list">
          ${data.links.map(l => `
            <div class="item">
              <div class="item-title"><span>${esc(l.localDevice)} ⇄ ${esc(l.remoteDevice)}</span><span>${esc(l.speed || "unknown")}</span></div>
              <div class="item-sub">${esc(l.localPort)} ⇄ ${esc(l.remotePort)} · down ${fmtMbps(l.inMbps)} / up ${fmtMbps(l.outMbps)} · ${fmtPct(l.utilPct)}</div>
              <div class="bar"><i style="--w:${Math.min(l.utilPct || 0, 100)}%; background:${colorByUtil(l.utilPct || 0)}"></i></div>
            </div>
          `).join("") || `<p class="empty">No discovered link traffic yet.</p>`}
        </div>
      `;
    })
    .catch(err => {
      els.panelBody.innerHTML = `<p class="empty">Top talkers failed: ${esc(err.message || String(err))}</p>`;
    });
}

const netmapOriginalRenderActivePanel = renderActivePanel;
renderActivePanel = function enhancedRenderActivePanel() {
  if (!topology) return;
  if (activeView === "search") return showSearch();
  if (activeView === "talkers") return showTalkers();
  return netmapOriginalRenderActivePanel();
};

netmapEnsureEnhancementNav();
netmapEnsureTicker();
netmapLoadTicker();
setInterval(netmapLoadTicker, 30000);
