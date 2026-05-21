import "dotenv/config";
import express from "express";
import axios from "axios";
import https from "https";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 8088);
const LIBRENMS_URL = (process.env.LIBRENMS_URL || "").replace(/\/+$/, "");
const LIBRENMS_TOKEN = process.env.LIBRENMS_TOKEN || "";
const MOCK_MODE = String(process.env.MOCK_MODE || "auto").toLowerCase();
const ALLOW_SELF_SIGNED = String(process.env.ALLOW_SELF_SIGNED_LIBRENMS || "false").toLowerCase() === "true";

const TOPOLOGY_TITLE = process.env.TOPOLOGY_TITLE || "DGE Sophos Enclave";
const TOPOLOGY_SUBTITLE = process.env.TOPOLOGY_SUBTITLE || "UXG edge, Sophos server-front, monitored by LibreNMS";

const MATCHERS = {
  edge: splitEnv("EDGE_DEVICE_MATCH", "uxg,unifi uxg,gateway,edge"),
  core: splitEnv("CORE_SWITCH_MATCH", "core,switch 1,switch1,main switch,agg"),
  firewall: splitEnv("SERVER_FIREWALL_MATCH", "sophos,enclave,firewall"),
  server: splitEnv("SERVER_MATCH", "librenms,server,vmware,proxmox,esxi,nas,hyper-v"),
  exclude: splitEnv("EXCLUDE_DEVICE_MATCH", "")
};

function splitEnv(name, fallback) {
  return String(process.env[name] ?? fallback)
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

function hasLiveConfig() {
  return Boolean(
    LIBRENMS_URL &&
    LIBRENMS_TOKEN &&
    !LIBRENMS_TOKEN.includes("replace_with")
  );
}

const httpsAgent = new https.Agent({
  rejectUnauthorized: !ALLOW_SELF_SIGNED
});

const librenms = axios.create({
  baseURL: LIBRENMS_URL,
  timeout: 20000,
  headers: {
    "X-Auth-Token": LIBRENMS_TOKEN,
    "Accept": "application/json"
  },
  httpsAgent
});

const app = express();
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(cors());
app.use(morgan("combined"));
app.use(express.json());
app.use("/vendor/cytoscape.min.js", express.static(path.join(__dirname, "node_modules/cytoscape/dist/cytoscape.min.js")));
app.use(express.static(path.join(__dirname, "public")));

function asArray(payload, keys) {
  for (const key of keys) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  if (Array.isArray(payload)) return payload;
  return [];
}

function n(value, fallback = 0) {
  const out = Number(value);
  return Number.isFinite(out) ? out : fallback;
}

function s(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function deviceName(device) {
  return s(device.display) ||
    s(device.sysName) ||
    s(device.hostname) ||
    s(device.name) ||
    `device-${s(device.device_id || device.id)}`;
}

function deviceId(device) {
  return s(device.device_id || device.id || device.hostname || deviceName(device));
}

function isUpDevice(device) {
  const status = device.status;
  if (status === true || status === 1 || status === "1" || String(status).toLowerCase() === "up") return true;
  if (device.disabled === true || device.ignore === true) return false;
  return String(status).toLowerCase() !== "down";
}

function matchesAny(haystack, needles) {
  const text = String(haystack || "").toLowerCase();
  return needles.some(x => x && text.includes(x));
}

function classifyDevice(device) {
  const haystack = [
    deviceName(device),
    device.hostname,
    device.sysName,
    device.os,
    device.hardware,
    device.type,
    device.ip
  ].filter(Boolean).join(" ").toLowerCase();

  if (matchesAny(haystack, MATCHERS.exclude)) return "exclude";
  if (matchesAny(haystack, MATCHERS.edge)) return "edge";
  if (matchesAny(haystack, MATCHERS.firewall)) return "firewall";
  if (matchesAny(haystack, MATCHERS.core)) return "core";
  if (matchesAny(haystack, MATCHERS.server)) return "server";
  if (haystack.includes("switch")) return "switch";
  if (haystack.includes("router") || haystack.includes("gateway")) return "edge";
  if (haystack.includes("firewall")) return "firewall";
  return "network";
}

function portName(port) {
  return s(port.ifAlias) || s(port.ifName) || s(port.ifDescr) || `port-${s(port.port_id || port.id)}`;
}

function portSpeedBps(port) {
  const ifSpeed = n(port.ifSpeed);
  if (ifSpeed > 0) return ifSpeed;
  const highSpeedMbps = n(port.ifHighSpeed);
  if (highSpeedMbps > 0) return highSpeedMbps * 1000 * 1000;
  return 0;
}

function normalizePort(port) {
  const inBps = n(port.ifInOctets_rate) * 8;
  const outBps = n(port.ifOutOctets_rate) * 8;
  const speedBps = portSpeedBps(port);
  const utilPct = speedBps > 0 ? Math.max(inBps, outBps) / speedBps * 100 : 0;

  return {
    port_id: s(port.port_id || port.id),
    device_id: s(port.device_id),
    name: portName(port),
    ifName: s(port.ifName),
    ifAlias: s(port.ifAlias),
    ifDescr: s(port.ifDescr),
    ifSpeed: speedBps,
    ifOperStatus: s(port.ifOperStatus || port.oper_status || "unknown"),
    ifAdminStatus: s(port.ifAdminStatus || "unknown"),
    inBps,
    outBps,
    inMbps: inBps / 1000 / 1000,
    outMbps: outBps / 1000 / 1000,
    utilPct,
    inErrorsRate: n(port.ifInErrors_rate),
    outErrorsRate: n(port.ifOutErrors_rate),
    pollTime: n(port.poll_time),
    pollPeriod: n(port.poll_period)
  };
}

function normalizeDevice(device) {
  const id = deviceId(device);
  const role = classifyDevice(device);
  return {
    id: `device-${id}`,
    device_id: id,
    label: deviceName(device),
    hostname: s(device.hostname),
    sysName: s(device.sysName),
    ip: s(device.ip || device.ipv4 || device.overwrite_ip),
    os: s(device.os),
    hardware: s(device.hardware),
    version: s(device.version),
    location: s(device.location),
    uptime: s(device.uptime || device.uptime_text),
    status: isUpDevice(device) ? "up" : "down",
    role,
    alerts: 0
  };
}

function normalizeLink(link, deviceById, portById) {
  const localId = s(link.local_device_id);
  const remoteId = s(link.remote_device_id);
  const localPortId = s(link.local_port_id);
  const remotePortId = s(link.remote_port_id);

  if (!localId || !remoteId) return null;
  if (!deviceById.has(localId) || !deviceById.has(remoteId)) return null;

  const localPort = portById.get(localPortId);
  const remotePort = portById.get(remotePortId);
  const chosen = localPort || remotePort || {};

  const active = link.active === undefined ? true : Boolean(Number(link.active));
  const inMbps = n(chosen.inMbps);
  const outMbps = n(chosen.outMbps);
  const utilPct = n(chosen.utilPct);

  return {
    id: `link-${s(link.id || `${localId}-${remoteId}-${localPortId}-${remotePortId}`)}`,
    source: `device-${localId}`,
    target: `device-${remoteId}`,
    localDeviceId: localId,
    remoteDeviceId: remoteId,
    localPortId,
    remotePortId,
    localPortName: localPort?.name || s(link.local_port) || localPortId,
    remotePortName: remotePort?.name || s(link.remote_port) || remotePortId,
    protocol: s(link.protocol || "discovered"),
    remoteHostname: s(link.remote_hostname),
    active,
    status: active ? "up" : "down",
    inMbps,
    outMbps,
    utilPct,
    speedBps: n(chosen.ifSpeed),
    inErrorsRate: n(chosen.inErrorsRate),
    outErrorsRate: n(chosen.outErrorsRate)
  };
}

async function getJson(route) {
  const { data } = await librenms.get(route);
  return data;
}

function mockRate(base, spread, offset = 0) {
  const phase = (Date.now() / 10000) + offset;
  return Math.max(0.01, base + Math.sin(phase) * spread + Math.cos(phase / 2) * spread / 2);
}

function mockTopology(reason = "mock mode") {
  const devices = [
    { id: "device-uxg", device_id: "uxg", label: "UXG Edge", hostname: "uxg-edge", ip: "172.16.60.1", os: "unifi", hardware: "UniFi UXG", location: "DGE Edge", status: "up", role: "edge", alerts: 0 },
    { id: "device-core", device_id: "core", label: "Core Switch", hostname: "sw-core-01", ip: "172.16.60.2", os: "switch", hardware: "Core switch", location: "Rack", status: "up", role: "core", alerts: 0 },
    { id: "device-sw2", device_id: "sw2", label: "Switch 2", hostname: "sw-access-02", ip: "172.16.60.3", os: "switch", hardware: "Access switch", location: "Rack", status: "up", role: "switch", alerts: 0 },
    { id: "device-sw3", device_id: "sw3", label: "Switch 3", hostname: "sw-access-03", ip: "172.16.60.4", os: "switch", hardware: "Access switch", location: "Rack", status: "up", role: "switch", alerts: 0 },
    { id: "device-sophos", device_id: "sophos", label: "Sophos Enclave", hostname: "fw-sophos-enclave", ip: "172.16.60.254", os: "sophos", hardware: "Sophos Firewall", location: "Server front", status: "up", role: "firewall", alerts: 1 },
    { id: "device-proxmox", device_id: "proxmox", label: "Proxmox Cluster", hostname: "pve-cluster", ip: "172.16.60.20", os: "proxmox", hardware: "Virtualization", location: "Servers", status: "up", role: "server", alerts: 0 },
    { id: "device-librenms", device_id: "librenms", label: "LibreNMS Stack", hostname: "librenms", ip: "172.16.60.30", os: "linux", hardware: "Docker host", location: "Monitoring", status: "up", role: "server", alerts: 0 },
    { id: "device-nas", device_id: "nas", label: "NAS / Backup", hostname: "nas-01", ip: "172.16.60.40", os: "storage", hardware: "Storage", location: "Servers", status: "up", role: "server", alerts: 1 }
  ];

  const mk = (id, source, target, a, b, base, spread, offset, speed = 1000000000) => {
    const inMbps = mockRate(base, spread, offset);
    const outMbps = mockRate(base * 0.7, spread * 0.8, offset + 4);
    const utilPct = Math.max(inMbps, outMbps) / (speed / 1000 / 1000) * 100;
    return {
      id,
      source,
      target,
      localPortName: a,
      remotePortName: b,
      protocol: "mock-lldp",
      status: "up",
      active: true,
      inMbps,
      outMbps,
      utilPct,
      speedBps: speed,
      inErrorsRate: id === "link-sophos-nas" ? 0.02 : 0,
      outErrorsRate: 0
    };
  };

  const links = [
    mk("link-uxg-core", "device-uxg", "device-core", "lan1", "gi1/0/1", 180, 45, 1, 1000000000),
    mk("link-core-sw2", "device-core", "device-sw2", "gi1/0/2", "gi1/0/48", 72, 22, 2, 1000000000),
    mk("link-core-sw3", "device-core", "device-sw3", "gi1/0/3", "gi1/0/48", 52, 18, 3, 1000000000),
    mk("link-core-sophos", "device-core", "device-sophos", "gi1/0/10", "lan", 140, 35, 4, 1000000000),
    mk("link-sophos-proxmox", "device-sophos", "device-proxmox", "dmz1", "bond0", 88, 26, 5, 1000000000),
    mk("link-sophos-librenms", "device-sophos", "device-librenms", "dmz2", "eth0", 16, 4, 6, 1000000000),
    mk("link-sophos-nas", "device-sophos", "device-nas", "dmz3", "eth0", 210, 65, 7, 1000000000)
  ];

  const ports = links.flatMap(link => ([
    {
      port_id: `${link.id}-a`,
      device_id: link.source.replace("device-", ""),
      name: link.localPortName,
      ifSpeed: link.speedBps,
      ifOperStatus: "up",
      inMbps: link.inMbps,
      outMbps: link.outMbps,
      utilPct: link.utilPct
    },
    {
      port_id: `${link.id}-b`,
      device_id: link.target.replace("device-", ""),
      name: link.remotePortName,
      ifSpeed: link.speedBps,
      ifOperStatus: "up",
      inMbps: link.outMbps,
      outMbps: link.inMbps,
      utilPct: link.utilPct
    }
  ]));

  const alerts = [
    { id: "mock-alert-1", device_id: "sophos", hostname: "fw-sophos-enclave", title: "High inspection utilization", severity: "warning", timestamp: new Date().toISOString() },
    { id: "mock-alert-2", device_id: "nas", hostname: "nas-01", title: "Backup volume nearing threshold", severity: "warning", timestamp: new Date().toISOString() }
  ];

  return buildResponse({ devices, links, ports, alerts, source: "mock", warnings: { mock: reason } });
}

function buildResponse({ devices, links, ports, alerts, source, warnings = {} }) {
  const totalInMbps = links.reduce((sum, link) => sum + n(link.inMbps), 0);
  const totalOutMbps = links.reduce((sum, link) => sum + n(link.outMbps), 0);

  return {
    status: "ok",
    generatedAt: new Date().toISOString(),
    source,
    title: TOPOLOGY_TITLE,
    subtitle: TOPOLOGY_SUBTITLE,
    mode: source === "mock" ? "mock" : "live",
    devices,
    links,
    ports,
    alerts,
    summary: {
      totalDevices: devices.length,
      upDevices: devices.filter(d => d.status === "up").length,
      downDevices: devices.filter(d => d.status !== "up").length,
      totalLinks: links.length,
      totalInMbps,
      totalOutMbps,
      activeAlerts: alerts.length
    },
    warnings
  };
}

app.get("/api/health", async (req, res) => {
  if (MOCK_MODE === "true" || (MOCK_MODE === "auto" && !hasLiveConfig())) {
    return res.json({
      status: "ok",
      mode: "mock",
      message: "Running in mock mode.",
      configured: hasLiveConfig()
    });
  }

  if (!hasLiveConfig()) {
    return res.status(500).json({
      status: "error",
      message: "Server is missing LIBRENMS_URL or LIBRENMS_TOKEN."
    });
  }

  try {
    await getJson("/api/v0");
    res.json({ status: "ok", mode: "live", librenms: LIBRENMS_URL });
  } catch (err) {
    res.status(502).json({
      status: "error",
      message: "Could not reach LibreNMS API.",
      detail: err.response?.data || err.message
    });
  }
});

app.get("/api/topology", async (req, res) => {
  if (MOCK_MODE === "true" || (MOCK_MODE === "auto" && !hasLiveConfig())) {
    return res.json(mockTopology(MOCK_MODE === "true" ? "MOCK_MODE=true" : "MOCK_MODE=auto and LibreNMS is not configured"));
  }

  if (!hasLiveConfig()) {
    return res.status(500).json({
      status: "error",
      message: "LibreNMS is not configured. Set MOCK_MODE=true or provide LIBRENMS_URL and LIBRENMS_TOKEN."
    });
  }

  try {
    const portColumns = [
      "port_id",
      "device_id",
      "ifName",
      "ifAlias",
      "ifDescr",
      "ifSpeed",
      "ifHighSpeed",
      "ifOperStatus",
      "ifAdminStatus",
      "ifInOctets_rate",
      "ifOutOctets_rate",
      "ifInErrors_rate",
      "ifOutErrors_rate",
      "poll_time",
      "poll_period"
    ].join(",");

    const [devicesPayload, linksPayload, portsPayload, alertsPayload] = await Promise.allSettled([
      getJson("/api/v0/devices"),
      getJson("/api/v0/resources/links"),
      getJson(`/api/v0/ports?columns=${encodeURIComponent(portColumns)}`),
      getJson("/api/v0/alerts?state=1&order=timestamp%20DESC")
    ]);

    if (devicesPayload.status === "rejected") {
      throw devicesPayload.reason;
    }

    const rawDevices = asArray(devicesPayload.value, ["devices", "device"]);
    const rawLinks = linksPayload.status === "fulfilled" ? asArray(linksPayload.value, ["links"]) : [];
    const rawPorts = portsPayload.status === "fulfilled" ? asArray(portsPayload.value, ["ports", "port"]) : [];
    const rawAlerts = alertsPayload.status === "fulfilled" ? asArray(alertsPayload.value, ["alerts"]) : [];

    const devices = rawDevices
      .map(normalizeDevice)
      .filter(d => d.role !== "exclude");

    const deviceById = new Map(devices.map(d => [d.device_id, d]));
    const ports = rawPorts.map(normalizePort);
    const portById = new Map(ports.map(p => [p.port_id, p]));

    const links = rawLinks
      .map(link => normalizeLink(link, deviceById, portById))
      .filter(Boolean);

    const alertCountsByDevice = new Map();
    for (const alert of rawAlerts) {
      const id = s(alert.device_id);
      alertCountsByDevice.set(id, (alertCountsByDevice.get(id) || 0) + 1);
    }

    for (const d of devices) {
      d.alerts = alertCountsByDevice.get(d.device_id) || 0;
    }

    const warnings = {
      links: linksPayload.status === "rejected" ? String(linksPayload.reason?.message || linksPayload.reason) : null,
      ports: portsPayload.status === "rejected" ? String(portsPayload.reason?.message || portsPayload.reason) : null,
      alerts: alertsPayload.status === "rejected" ? String(alertsPayload.reason?.message || alertsPayload.reason) : null
    };

    res.json(buildResponse({
      devices,
      links,
      ports,
      alerts: rawAlerts.slice(0, 50),
      source: LIBRENMS_URL,
      warnings
    }));
  } catch (err) {
    if (MOCK_MODE === "auto") {
      return res.json(mockTopology(`LibreNMS failed, auto fallback: ${err.message}`));
    }

    res.status(502).json({
      status: "error",
      message: "Could not build topology from LibreNMS.",
      detail: err.response?.data || err.message
    });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`NetMap listening on http://0.0.0.0:${PORT}`);
  console.log(`Mode: ${MOCK_MODE}`);
});
