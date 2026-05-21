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
const HIDE_DOWN_INTERFACES = String(process.env.HIDE_DOWN_INTERFACES || "false").toLowerCase() === "true";
const DEFAULT_REFRESH_MS = Number(process.env.DEFAULT_REFRESH_MS || 30000);
const CACHE_MS = Number(process.env.CACHE_MS || 10000);

// Large LibreNMS / work-environment tuning
const SWITCH_ONLY_MODE = String(process.env.SWITCH_ONLY_MODE || "false").toLowerCase() === "true";
const DEVICE_ROLE_ALLOWLIST = splitEnv("DEVICE_ROLE_ALLOWLIST", "");
const SWITCH_DEVICE_MATCH = splitEnv(
  "SWITCH_DEVICE_MATCH",
  "switch,sw-,core,access,closet,idf,mdf,aruba,hpe,procurve,juniper,junos,ex2300,ex3400,ex4300,ex4400,qfx,cx,2930,3810,5400,6200,6300,6400,8320"
);
const MAX_TOPOLOGY_LINKS = Number(process.env.MAX_TOPOLOGY_LINKS || 0);
const PORT_DETAIL_LIMIT = Number(process.env.PORT_DETAIL_LIMIT || 0);

const TOPOLOGY_TITLE = process.env.TOPOLOGY_TITLE || "LibreNMS Network Fabric";
const TOPOLOGY_SUBTITLE = process.env.TOPOLOGY_SUBTITLE || "Enterprise topology, interface utilization, alerts, and device inventory";

const MATCHERS = {
  edge: splitEnv("EDGE_DEVICE_MATCH", "uxg,unifi uxg,gateway,edge,wan,router,border"),
  core: splitEnv("CORE_SWITCH_MATCH", "core,coresw,core-sw,dist,distribution,agg,aggregation,spine"),
  access: splitEnv("ACCESS_SWITCH_MATCH", "access,access-sw,edge-sw,closet,idf,switch,sw-"),
  firewall: splitEnv("FIREWALL_MATCH", "sophos,fortigate,fortinet,palo,pa-,checkpoint,firewall,fw-"),
  server: splitEnv("SERVER_MATCH", "librenms,server,vmware,proxmox,esxi,nas,storage,hyper-v,windows,linux"),
  wireless: splitEnv("WIRELESS_MATCH", "mist,ap-,aruba ap,access point,wifi,wireless"),
  juniper: splitEnv("JUNIPER_MATCH", "juniper,ex2300,ex3400,ex4300,ex4400,ex4650,qfx,srx,mist,junos"),
  aruba: splitEnv("ARUBA_MATCH", "aruba,procurve,hpe,2930,3810,5400,6200,6300,6400,8320,cx"),
  unifi: splitEnv("UNIFI_MATCH", "unifi,ubiquiti,uxg,usw,udm"),
  sophos: splitEnv("SOPHOS_MATCH", "sophos"),
  exclude: splitEnv("EXCLUDE_DEVICE_MATCH", "")
};

function splitEnv(name, fallback) {
  return String(process.env[name] ?? fallback).split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}
function hasLiveConfig() { return Boolean(LIBRENMS_URL && LIBRENMS_TOKEN && !LIBRENMS_TOKEN.includes("replace_with")); }
function asArray(payload, keys) { for (const key of keys) if (Array.isArray(payload?.[key])) return payload[key]; return Array.isArray(payload) ? payload : []; }
function n(v, fallback = 0) { const out = Number(v); return Number.isFinite(out) ? out : fallback; }
function s(v, fallback = "") { return v === null || v === undefined ? fallback : String(v); }
function matchesAny(haystack, needles) { const text = String(haystack || "").toLowerCase(); return needles.some(x => x && text.includes(x)); }
function deviceName(d) { return s(d.display) || s(d.sysName) || s(d.hostname) || s(d.name) || `device-${s(d.device_id || d.id)}`; }
function deviceId(d) { return s(d.device_id || d.id || d.hostname || deviceName(d)); }
function haystackDevice(d) { return [deviceName(d), d.hostname, d.sysName, d.os, d.hardware, d.type, d.ip, d.location, d.version].filter(Boolean).join(" ").toLowerCase(); }
function isUpDevice(d) { const status = d.status; if ([true, 1, "1", "up"].includes(status)) return true; if (d.disabled === true || d.ignore === true) return false; return String(status).toLowerCase() !== "down"; }
function speedLabel(bps) { const x = n(bps); if (!x) return "unknown"; const g = x / 1000 / 1000 / 1000; return g >= 1 ? `${Number.isInteger(g) ? g.toFixed(0) : g.toFixed(1)}G` : `${(x / 1000 / 1000).toFixed(0)}M`; }
function portName(p) { return s(p.ifAlias) || s(p.ifName) || s(p.ifDescr) || `port-${s(p.port_id || p.id)}`; }
function portSpeedBps(p) { const ifSpeed = n(p.ifSpeed); if (ifSpeed > 0) return ifSpeed; const high = n(p.ifHighSpeed); return high > 0 ? high * 1000 * 1000 : 0; }

function vendorForDevice(d) {
  const h = haystackDevice(d);
  if (matchesAny(h, MATCHERS.juniper)) return "juniper";
  if (matchesAny(h, MATCHERS.aruba)) return "aruba";
  if (matchesAny(h, MATCHERS.unifi)) return "unifi";
  if (matchesAny(h, MATCHERS.sophos)) return "sophos";
  if (h.includes("cisco")) return "cisco";
  if (h.includes("fortinet") || h.includes("fortigate")) return "fortinet";
  if (h.includes("palo")) return "paloalto";
  return "unknown";
}

function classifyDevice(d) {
  const h = haystackDevice(d);
  const vendor = vendorForDevice(d);
  if (matchesAny(h, MATCHERS.exclude)) return "exclude";
  if (matchesAny(h, MATCHERS.firewall)) return "firewall";
  if (matchesAny(h, MATCHERS.edge)) return "edge";
  if (matchesAny(h, MATCHERS.core)) return "core";
  if (matchesAny(h, MATCHERS.wireless)) return "wireless";
  if (matchesAny(h, MATCHERS.server)) return "server";
  if (matchesAny(h, MATCHERS.access)) return "access";
  if (["juniper", "aruba", "unifi", "cisco"].includes(vendor)) return "access";
  if (h.includes("switch")) return "access";
  if (h.includes("router") || h.includes("gateway")) return "edge";
  if (h.includes("firewall")) return "firewall";
  return "network";
}

function normalizeDevice(d) {
  const id = deviceId(d);
  const role = classifyDevice(d);
  const vendor = vendorForDevice(d);
  return {
    id: `device-${id}`, device_id: id, label: deviceName(d), hostname: s(d.hostname), sysName: s(d.sysName),
    ip: s(d.ip || d.ipv4 || d.overwrite_ip), os: s(d.os), hardware: s(d.hardware), version: s(d.version),
    location: s(d.location), uptime: s(d.uptime || d.uptime_text), status: isUpDevice(d) ? "up" : "down",
    role, vendor, alerts: 0, ports: 0, upPorts: 0, downPorts: 0, trafficInMbps: 0, trafficOutMbps: 0
  };
}

function normalizePort(p, deviceById) {
  const inBps = n(p.ifInOctets_rate) * 8;
  const outBps = n(p.ifOutOctets_rate) * 8;
  const speedBps = portSpeedBps(p);
  const utilPct = speedBps > 0 ? Math.max(inBps, outBps) / speedBps * 100 : 0;
  const device_id = s(p.device_id);
  const device = deviceById.get(device_id);
  return {
    port_id: s(p.port_id || p.id), device_id, device_label: device?.label || device_id, device_role: device?.role || "unknown",
    device_vendor: device?.vendor || "unknown", name: portName(p), ifName: s(p.ifName), ifAlias: s(p.ifAlias), ifDescr: s(p.ifDescr), ifType: s(p.ifType),
    ifSpeed: speedBps, speedLabel: speedLabel(speedBps), ifOperStatus: s(p.ifOperStatus || p.oper_status || "unknown"), ifAdminStatus: s(p.ifAdminStatus || "unknown"),
    inBps, outBps, inMbps: inBps / 1000 / 1000, outMbps: outBps / 1000 / 1000, utilPct,
    inErrorsRate: n(p.ifInErrors_rate), outErrorsRate: n(p.ifOutErrors_rate), inDiscardsRate: n(p.ifInDiscards_rate), outDiscardsRate: n(p.ifOutDiscards_rate),
    pollTime: n(p.poll_time), pollPeriod: n(p.poll_period)
  };
}

function normalizeLink(l, deviceById, portById) {
  const localId = s(l.local_device_id), remoteId = s(l.remote_device_id), localPortId = s(l.local_port_id), remotePortId = s(l.remote_port_id);
  if (!localId || !remoteId || !deviceById.has(localId) || !deviceById.has(remoteId)) return null;
  const localPort = portById.get(localPortId), remotePort = portById.get(remotePortId), chosen = localPort || remotePort || {};
  const active = l.active === undefined ? true : Boolean(Number(l.active));
  return {
    id: `link-${s(l.id || `${localId}-${remoteId}-${localPortId}-${remotePortId}`)}`,
    source: `device-${localId}`, target: `device-${remoteId}`, localDeviceId: localId, remoteDeviceId: remoteId,
    localDeviceLabel: deviceById.get(localId)?.label || localId, remoteDeviceLabel: deviceById.get(remoteId)?.label || remoteId,
    localPortId, remotePortId, localPortName: localPort?.name || s(l.local_port) || s(l.local_port_name) || localPortId,
    remotePortName: remotePort?.name || s(l.remote_port) || s(l.remote_port_name) || remotePortId,
    protocol: s(l.protocol || "discovered"), remoteHostname: s(l.remote_hostname), active, status: active ? "up" : "down",
    inMbps: n(chosen.inMbps), outMbps: n(chosen.outMbps), utilPct: n(chosen.utilPct), speedBps: n(chosen.ifSpeed), speedLabel: speedLabel(n(chosen.ifSpeed)),
    inErrorsRate: n(chosen.inErrorsRate), outErrorsRate: n(chosen.outErrorsRate), inDiscardsRate: n(chosen.inDiscardsRate), outDiscardsRate: n(chosen.outDiscardsRate)
  };
}

function attachDevicePortStats(device, ports) {
  const my = ports.filter(p => p.device_id === device.device_id);
  device.ports = my.length;
  device.upPorts = my.filter(p => p.ifOperStatus === "up").length;
  device.downPorts = my.filter(p => p.ifOperStatus && p.ifOperStatus !== "up").length;
  device.trafficInMbps = my.reduce((sum, p) => sum + n(p.inMbps), 0);
  device.trafficOutMbps = my.reduce((sum, p) => sum + n(p.outMbps), 0);
}

function countBy(items, key) { const out = {}; for (const item of items) { const v = item[key] || "unknown"; out[v] = (out[v] || 0) + 1; } return out; }
function buildResponse({ devices, links, ports, alerts, source, warnings = {} }) {
  const filteredPorts = HIDE_DOWN_INTERFACES ? ports.filter(p => p.ifOperStatus === "up") : ports;
  return {
    status: "ok", generatedAt: new Date().toISOString(), source, title: TOPOLOGY_TITLE, subtitle: TOPOLOGY_SUBTITLE,
    mode: source === "mock" ? "mock" : "live", settings: { defaultRefreshMs: DEFAULT_REFRESH_MS, hideDownInterfaces: HIDE_DOWN_INTERFACES },
    devices, links, ports: filteredPorts, alerts,
    summary: {
      totalDevices: devices.length, upDevices: devices.filter(d => d.status === "up").length, downDevices: devices.filter(d => d.status !== "up").length,
      totalLinks: links.length, totalPorts: filteredPorts.length, upPorts: filteredPorts.filter(p => String(p.ifOperStatus).toLowerCase() === "up").length,
      downPorts: filteredPorts.filter(p => p.ifOperStatus && String(p.ifOperStatus).toLowerCase() !== "up").length,
      totalInMbps: links.reduce((sum, l) => sum + n(l.inMbps), 0), totalOutMbps: links.reduce((sum, l) => sum + n(l.outMbps), 0), activeAlerts: alerts.length,
      vendorCounts: countBy(devices, "vendor"), roleCounts: countBy(devices, "role")
    }, warnings
  };
}

const httpsAgent = new https.Agent({ rejectUnauthorized: !ALLOW_SELF_SIGNED });
const librenms = axios.create({ baseURL: LIBRENMS_URL, timeout: 25000, headers: { "X-Auth-Token": LIBRENMS_TOKEN, "Accept": "application/json" }, httpsAgent });
async function getJson(route) { const { data } = await librenms.get(route); return data; }

let cache = null, cacheTime = 0;
async function buildLiveTopology() {
  const now = Date.now();
  if (cache && now - cacheTime < CACHE_MS) return cache;
  const portColumns = ["port_id","device_id","ifName","ifAlias","ifDescr","ifType","ifSpeed","ifHighSpeed","ifOperStatus","ifAdminStatus","ifInOctets_rate","ifOutOctets_rate","ifInErrors_rate","ifOutErrors_rate","ifInDiscards_rate","ifOutDiscards_rate","poll_time","poll_period"].join(",");
  const [devicesPayload, linksPayload, portsPayload, alertsPayload] = await Promise.allSettled([
    getJson("/api/v0/devices"), getJson("/api/v0/resources/links"), getPortsPayload(), getJson("/api/v0/alerts?state=1&order=timestamp%20DESC")
  ]);
  if (devicesPayload.status === "rejected") throw devicesPayload.reason;
  const rawDevices = asArray(devicesPayload.value, ["devices", "device"]);
  const rawLinks = linksPayload.status === "fulfilled" ? asArray(linksPayload.value, ["links"]) : [];
  const rawPorts = portsPayload.status === "fulfilled" ? asArray(portsPayload.value, ["ports", "port", "interfaces", "ifaces", "data"]) : [];
  const rawAlerts = alertsPayload.status === "fulfilled" ? asArray(alertsPayload.value, ["alerts"]) : [];
  const devices = rawDevices.map(normalizeDevice).filter(d => d.role !== "exclude");
  const deviceById = new Map(devices.map(d => [d.device_id, d]));

  const limitedRawLinks = limitTopologyLinks(rawLinks);

  const linkPortIds = limitedRawLinks.flatMap(l => [
    l.local_port_id,
    l.remote_port_id
  ]).filter(Boolean).slice(0, PORT_DETAIL_LIMIT);

  const directPortDetails = PORT_DETAIL_LIMIT > 0
    ? await getPortDetailsMap(linkPortIds)
    : new Map();

  for (const detailedPort of directPortDetails.values()) {
    const id = String(detailedPort.port_id || detailedPort.id || "");
    const idx = rawPorts.findIndex(p => String(p.port_id || p.id || "") === id);
    if (idx >= 0) {
      rawPorts[idx] = { ...rawPorts[idx], ...detailedPort };
    } else {
      rawPorts.push(detailedPort);
    }
  }

  const ports = rawPorts.map(p => normalizePort(p, deviceById));
  const portById = new Map(ports.map(p => [String(p.port_id), p]));
  const links = rawLinks.map(l => normalizeLink(l, deviceById, portById)).filter(Boolean);
  const alertCounts = new Map();
  for (const alert of rawAlerts) alertCounts.set(s(alert.device_id), (alertCounts.get(s(alert.device_id)) || 0) + 1);
  for (const d of devices) { d.alerts = alertCounts.get(d.device_id) || 0; attachDevicePortStats(d, ports); }
  cache = buildResponse({ devices, links, ports, alerts: rawAlerts.slice(0, 200), source: LIBRENMS_URL, warnings: {
    links: linksPayload.status === "rejected" ? String(linksPayload.reason?.message || linksPayload.reason) : null,
    ports: portsPayload.status === "rejected" ? String(portsPayload.reason?.message || portsPayload.reason) : null,
    alerts: alertsPayload.status === "rejected" ? String(alertsPayload.reason?.message || alertsPayload.reason) : null
  }});
  cacheTime = now;
  return cache;
}


async function getPortsPayload() {
  // LibreNMS installs/versions can be picky about columns.
  // Try a safe reduced column set first, then fall back to the full ports endpoint.
  const safeColumns = [
    "port_id",
    "device_id",
    "ifName",
    "ifAlias",
    "ifDescr",
    "ifType",
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

  const attempts = [
    `/api/v0/ports?columns=${encodeURIComponent(safeColumns)}`,
    "/api/v0/ports"
  ];

  let lastError = null;

  for (const route of attempts) {
    try {
      const data = await getJson(route);
      const ports = asArray(data, ["ports", "port", "interfaces", "ifaces", "data"]);
      if (ports.length > 0) {
        return data;
      }
      lastError = new Error(`No ports returned from ${route}`);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error("Unable to retrieve LibreNMS ports");
}


async function getPortDetail(portId) {
  if (!portId) return null;

  try {
    const data = await getJson(`/api/v0/ports/${portId}`);
    const ports = asArray(data, ["port", "ports", "data", "interfaces", "ifaces"]);
    if (ports.length > 0) return ports[0];
  } catch (err) {
    console.warn(`LibreNMS port detail failed for ${portId}:`, err.message || err);
  }

  return null;
}

async function getPortDetailsMap(portIds) {
  const uniqueIds = [...new Set(portIds.filter(Boolean).map(String))];

  const results = await Promise.allSettled(
    uniqueIds.map(async id => [id, await getPortDetail(id)])
  );

  const out = new Map();

  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const [id, port] = result.value;
    if (port) out.set(String(id), port);
  }

  return out;
}

function mockRate(base, spread, offset = 0) { const phase = Date.now() / 10000 + offset; return Math.max(0.01, base + Math.sin(phase) * spread + Math.cos(phase / 2) * spread / 2); }
function mockTopology(reason = "mock mode") {
  const devices = [
    { id:"device-fw01",device_id:"fw01",label:"Sophos Firewall",hostname:"fw-sophos-01",ip:"10.20.1.1",os:"sophos",hardware:"Sophos Firewall",location:"Edge",status:"up",role:"firewall",vendor:"sophos",alerts:1 },
    { id:"device-core01",device_id:"core01",label:"Aruba CX Core",hostname:"core-aruba-01",ip:"10.20.2.1",os:"arubaos-cx",hardware:"Aruba CX 6300",location:"MDF",status:"up",role:"core",vendor:"aruba",alerts:0 },
    { id:"device-dist01",device_id:"dist01",label:"Juniper EX Distribution",hostname:"dist-juniper-01",ip:"10.20.2.2",os:"junos",hardware:"Juniper EX4400",location:"MDF",status:"up",role:"core",vendor:"juniper",alerts:0 },
    { id:"device-idf01",device_id:"idf01",label:"Aruba IDF Switch",hostname:"idf-aruba-01",ip:"10.20.3.1",os:"arubaos-cx",hardware:"Aruba CX 6200",location:"IDF-1",status:"up",role:"access",vendor:"aruba",alerts:0 },
    { id:"device-idf02",device_id:"idf02",label:"Juniper Mist Switch",hostname:"idf-mist-02",ip:"10.20.3.2",os:"junos",hardware:"Juniper EX3400 Mist",location:"IDF-2",status:"up",role:"access",vendor:"juniper",alerts:0 },
    { id:"device-ap01",device_id:"ap01",label:"Mist AP Lobby",hostname:"ap-mist-lobby",ip:"10.20.40.21",os:"mist",hardware:"Juniper Mist AP",location:"Lobby",status:"up",role:"wireless",vendor:"juniper",alerts:0 },
    { id:"device-esxi",device_id:"esxi",label:"VMware Cluster",hostname:"esxi-cluster",ip:"10.20.50.10",os:"vmware",hardware:"Dell Host",location:"Server Room",status:"up",role:"server",vendor:"unknown",alerts:0 },
    { id:"device-librenms",device_id:"librenms",label:"LibreNMS",hostname:"librenms",ip:"10.20.50.20",os:"linux",hardware:"Docker",location:"Server Room",status:"up",role:"server",vendor:"unknown",alerts:0 }
  ];
  const mk = (id, source, target, a, b, base, spread, offset, speed = 1000000000) => { const inMbps = mockRate(base, spread, offset); const outMbps = mockRate(base*.7, spread*.8, offset+4); const utilPct = Math.max(inMbps,outMbps)/(speed/1000/1000)*100; return { id, source, target, localPortName:a, remotePortName:b, protocol:"mock-lldp", status:"up", active:true, inMbps, outMbps, utilPct, speedBps:speed, speedLabel:speedLabel(speed), inErrorsRate:0, outErrorsRate:0, inDiscardsRate:0, outDiscardsRate:0 }; };
  const links = [mk("link-fw-core","device-fw01","device-core01","xg1","1/1/48",420,90,1,10000000000), mk("link-core-dist","device-core01","device-dist01","1/1/49","xe-0/1/0",620,140,2,10000000000), mk("link-core-idf01","device-core01","device-idf01","1/1/10","1/1/48",180,60,3), mk("link-dist-idf02","device-dist01","device-idf02","ge-0/0/10","ge-0/0/48",150,40,4), mk("link-idf02-ap01","device-idf02","device-ap01","ge-0/0/4","eth0",42,12,5), mk("link-core-esxi","device-core01","device-esxi","1/1/20","vmnic0",750,180,6,10000000000), mk("link-core-librenms","device-core01","device-librenms","1/1/30","eth0",22,8,7)];
  const ports = links.flatMap(l => [{ port_id:`${l.id}-a`, device_id:l.source.replace("device-", ""), device_label:devices.find(d=>d.id===l.source)?.label, name:l.localPortName, ifName:l.localPortName, ifAlias:devices.find(d=>d.id===l.target)?.label, ifType:"ethernetCsmacd", ifSpeed:l.speedBps, speedLabel:l.speedLabel, ifOperStatus:"up", ifAdminStatus:"up", inMbps:l.inMbps, outMbps:l.outMbps, utilPct:l.utilPct, inErrorsRate:l.inErrorsRate, outErrorsRate:0, inDiscardsRate:0, outDiscardsRate:0 }, { port_id:`${l.id}-b`, device_id:l.target.replace("device-", ""), device_label:devices.find(d=>d.id===l.target)?.label, name:l.remotePortName, ifName:l.remotePortName, ifAlias:devices.find(d=>d.id===l.source)?.label, ifType:"ethernetCsmacd", ifSpeed:l.speedBps, speedLabel:l.speedLabel, ifOperStatus:"up", ifAdminStatus:"up", inMbps:l.outMbps, outMbps:l.inMbps, utilPct:l.utilPct, inErrorsRate:0, outErrorsRate:0, inDiscardsRate:0, outDiscardsRate:0 }]);
  const alerts = [{ id:"mock-alert-1", device_id:"fw01", hostname:"fw-sophos-01", title:"High inspection utilization", severity:"warning", timestamp:new Date().toISOString() }];
  for (const d of devices) attachDevicePortStats(d, ports);
  return buildResponse({ devices, links, ports, alerts, source:"mock", warnings:{ mock: reason }});
}

async function currentTopology() {
  if (MOCK_MODE === "true" || (MOCK_MODE === "auto" && !hasLiveConfig())) return mockTopology(MOCK_MODE === "true" ? "MOCK_MODE=true" : "MOCK_MODE=auto and LibreNMS is not configured");
  if (!hasLiveConfig()) throw new Error("LibreNMS is not configured. Set MOCK_MODE=true or provide LIBRENMS_URL and LIBRENMS_TOKEN.");
  try { return await buildLiveTopology(); } catch (err) { if (MOCK_MODE === "auto") return mockTopology(`LibreNMS failed, auto fallback: ${err.message}`); throw err; }
}

const app = express();
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors());
app.use(morgan("combined"));
app.use(express.json());
app.use("/vendor/cytoscape.min.js", express.static(path.join(__dirname, "node_modules/cytoscape/dist/cytoscape.min.js")));
app.use(express.static(path.join(__dirname, "public")));


function normalizeMac(input) {
  const compact = String(input || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  if (compact.length !== 12) return null;
  return {
    compact,
    colon: compact.match(/.{1,2}/g).join(":")
  };
}

function looksLikeIpOrCidr(input) {
  return /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(String(input || "").trim());
}

function looksLikeMac(input) {
  return normalizeMac(input) !== null;
}

function safeArray(payload, keys) {
  return asArray(payload, keys);
}

async function tryGetJson(route) {
  try {
    return await getJson(route);
  } catch (err) {
    return {
      status: "error",
      route,
      error: err.response?.data || err.message || String(err)
    };
  }
}

async function searchPortDetail(portId) {
  if (!portId) return null;

  try {
    const data = await getJson(`/api/v0/ports/${portId}`);
    const ports = asArray(data, ["port", "ports", "data", "interfaces", "ifaces"]);
    return ports[0] || null;
  } catch {
    return null;
  }
}

function portDisplayFromRaw(port) {
  if (!port) return null;
  const name = s(port.ifName) || s(port.ifDescr) || s(port.ifAlias) || s(port.port_id || port.id);
  const alias = s(port.ifAlias);
  return {
    port_id: s(port.port_id || port.id),
    device_id: s(port.device_id),
    name,
    alias,
    label: alias && alias !== name ? `${name} — ${alias}` : name,
    ifName: s(port.ifName),
    ifAlias: s(port.ifAlias),
    ifDescr: s(port.ifDescr),
    ifSpeed: portSpeedBps(port),
    speedLabel: speedLabel(portSpeedBps(port)),
    ifOperStatus: normalizeOperStatus ? normalizeOperStatus(port.ifOperStatus || port.oper_status) : s(port.ifOperStatus || port.oper_status)
  };
}

function normalizeSearchResult(result) {
  return {
    source: result.source || "unknown",
    ip: result.ip || "",
    mac: result.mac || "",
    vlan: result.vlan || "",
    device: result.device || "",
    hostname: result.hostname || "",
    sysName: result.sysName || "",
    port_id: result.port_id || "",
    port: result.port || "",
    portAlias: result.portAlias || "",
    speed: result.speed || "",
    lastSeen: result.lastSeen || "",
    updatedAt: result.updatedAt || "",
    raw: result.raw || {}
  };
}

async function lookupArp(query) {
  const routes = [`/api/v0/resources/ip/arp/${encodeURIComponent(query)}`];

  const mac = normalizeMac(query);
  if (mac) {
    routes.push(`/api/v0/resources/ip/arp/${encodeURIComponent(mac.colon)}`);
    routes.push(`/api/v0/resources/ip/arp/${encodeURIComponent(mac.compact)}`);
  }

  for (const route of routes) {
    const data = await tryGetJson(route);
    const rows = safeArray(data, ["arp", "data", "results"]);
    if (rows.length > 0) {
      return rows;
    }
  }

  return [];
}

async function lookupFdb(macInput) {
  const mac = normalizeMac(macInput);
  if (!mac) return [];

  const routes = [
    `/api/v0/resources/fdb/${encodeURIComponent(mac.compact)}/detail`,
    `/api/v0/resources/fdb/${encodeURIComponent(mac.colon)}/detail`,
    `/api/v0/resources/fdb/${encodeURIComponent(mac.compact)}`,
    `/api/v0/resources/fdb/${encodeURIComponent(mac.colon)}`
  ];

  for (const route of routes) {
    const data = await tryGetJson(route);
    const rows = safeArray(data, ["ports_fdb", "fdb", "data", "results"]);
    if (rows.length > 0) {
      return rows;
    }
  }

  return [];
}

async function hydrateArpResults(arpRows) {
  const out = [];

  for (const row of arpRows) {
    const portId = s(row.port_id);
    const port = await searchPortDetail(portId);
    const portInfo = portDisplayFromRaw(port);

    out.push(normalizeSearchResult({
      source: "ARP",
      ip: s(row.ipv4_address || row.ip || row.ip_address),
      mac: normalizeMac(row.mac_address || row.mac)?.colon || s(row.mac_address || row.mac),
      vlan: s(row.vlan || row.vlan_id),
      device: portInfo?.device_id || s(row.device_id),
      port_id: portId,
      port: portInfo?.label || portInfo?.name || "",
      portAlias: portInfo?.alias || "",
      speed: portInfo?.speedLabel || "",
      updatedAt: s(row.updated_at || row.last_updated),
      raw: row
    }));
  }

  return out;
}

async function hydrateFdbResults(fdbRows) {
  const out = [];

  for (const row of fdbRows) {
    const portId = s(row.port_id);
    const port = portId ? await searchPortDetail(portId) : null;
    const portInfo = portDisplayFromRaw(port);

    const mac = normalizeMac(row.mac || row.mac_address) || normalizeMac(row.mac_address_raw);

    out.push(normalizeSearchResult({
      source: "FDB",
      ip: s(row.ip || row.ipv4_address),
      mac: mac?.colon || s(row.mac || row.mac_address),
      vlan: s(row.vlan || row.vlan_id || row.vlan_vlan),
      device: s(row.hostname || row.device || row.device_id || portInfo?.device_id),
      hostname: s(row.hostname),
      sysName: s(row.sysName),
      port_id: portId,
      port: s(row.ifName || row.ifDescr || row.ifAlias || portInfo?.label || portInfo?.name),
      portAlias: s(row.ifAlias || portInfo?.alias),
      speed: portInfo?.speedLabel || "",
      lastSeen: s(row.last_seen),
      updatedAt: s(row.updated_at || row.created_at),
      raw: row
    }));
  }

  return out;
}

function dedupeSearchResults(rows) {
  const seen = new Set();
  const out = [];

  for (const row of rows) {
    const key = [
      row.source,
      row.ip,
      row.mac,
      row.device,
      row.port_id,
      row.port,
      row.vlan,
      row.updatedAt
    ].join("|");

    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }

  return out;
}

app.get("/api/health", async (req, res) => {
  if (MOCK_MODE === "true" || (MOCK_MODE === "auto" && !hasLiveConfig())) return res.json({ status:"ok", mode:"mock", message:"Running in mock mode.", configured:hasLiveConfig() });
  if (!hasLiveConfig()) return res.status(500).json({ status:"error", message:"Server is missing LIBRENMS_URL or LIBRENMS_TOKEN." });
  try { await getJson("/api/v0"); res.json({ status:"ok", mode:"live", librenms:LIBRENMS_URL }); } catch (err) { res.status(502).json({ status:"error", message:"Could not reach LibreNMS API.", detail:err.response?.data || err.message }); }
});
app.get("/api/topology", async (req, res) => { try { res.json(await currentTopology()); } catch (err) { res.status(502).json({ status:"error", message:"Could not build topology from LibreNMS.", detail:err.response?.data || err.message }); } });
app.get("/api/devices", async (req, res) => { try { const d = await currentTopology(); res.json({ status:"ok", generatedAt:d.generatedAt, devices:d.devices, summary:d.summary }); } catch (err) { res.status(502).json({ status:"error", message:err.message }); } });
app.get("/api/interfaces", async (req, res) => { try { const d = await currentTopology(); let ports = d.ports; const device = s(req.query.device), role = s(req.query.role); if (device) ports = ports.filter(p => p.device_id === device || p.device_label === device); if (role) ports = ports.filter(p => p.device_role === role); res.json({ status:"ok", generatedAt:d.generatedAt, interfaces:ports, summary:{ total:ports.length, up:ports.filter(p=>p.ifOperStatus==="up").length, down:ports.filter(p=>p.ifOperStatus && p.ifOperStatus!=="up").length, totalInMbps:ports.reduce((sum,p)=>sum+n(p.inMbps),0), totalOutMbps:ports.reduce((sum,p)=>sum+n(p.outMbps),0) } }); } catch (err) { res.status(502).json({ status:"error", message:err.message }); } });
app.get("/api/links", async (req, res) => { try { const d = await currentTopology(); res.json({ status:"ok", generatedAt:d.generatedAt, links:d.links, summary:{ total:d.links.length, totalInMbps:d.links.reduce((sum,l)=>sum+n(l.inMbps),0), totalOutMbps:d.links.reduce((sum,l)=>sum+n(l.outMbps),0) } }); } catch (err) { res.status(502).json({ status:"error", message:err.message }); } });

app.get("/api/search", async (req, res) => {
  const query = String(req.query.q || "").trim();

  if (!query) {
    return res.status(400).json({
      status: "error",
      message: "Missing search query. Provide ?q=IP, MAC, or CIDR."
    });
  }

  try {
    let arpRows = [];
    let fdbRows = [];

    if (looksLikeIpOrCidr(query)) {
      arpRows = await lookupArp(query);

      // If IP/CIDR lookup gives MACs, follow those into FDB to locate switch ports.
      const macs = [...new Set(arpRows.map(r => normalizeMac(r.mac_address || r.mac)?.compact).filter(Boolean))];
      for (const mac of macs.slice(0, 50)) {
        fdbRows.push(...await lookupFdb(mac));
      }
    } else if (looksLikeMac(query)) {
      arpRows = await lookupArp(query);
      fdbRows = await lookupFdb(query);
    } else {
      return res.status(400).json({
        status: "error",
        message: "Search must be an IP address, CIDR, or MAC address."
      });
    }

    const results = dedupeSearchResults([
      ...await hydrateArpResults(arpRows),
      ...await hydrateFdbResults(fdbRows)
    ]);

    res.json({
      status: "ok",
      query,
      count: results.length,
      results
    });
  } catch (err) {
    res.status(502).json({
      status: "error",
      message: "Search failed.",
      detail: err.response?.data || err.message || String(err)
    });
  }
});


function netmapNormalizeMac(input) {
  const compact = String(input || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  if (compact.length !== 12) return null;
  return {
    compact,
    colon: compact.match(/.{1,2}/g).join(":")
  };
}

function netmapLooksLikeIpOrCidr(input) {
  return /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(String(input || "").trim());
}

function netmapLooksLikeMac(input) {
  return netmapNormalizeMac(input) !== null;
}

async function netmapTryGet(route) {
  try {
    return await getJson(route);
  } catch (err) {
    return {
      __netmap_error: true,
      route,
      error: err.response?.data || err.message || String(err)
    };
  }
}

async function netmapTopology() {
  if (typeof buildLiveTopology === "function") {
    return await buildLiveTopology();
  }

  throw new Error("buildLiveTopology is unavailable");
}

async function netmapPortDetail(portId) {
  if (!portId) return null;

  try {
    const data = await getJson(`/api/v0/ports/${encodeURIComponent(portId)}`);
    const rows = asArray(data, ["port", "ports", "data", "interfaces", "ifaces"]);
    return rows[0] || null;
  } catch {
    return null;
  }
}

function netmapPortInfo(rawPort, topo) {
  if (!rawPort) return null;

  const portId = s(rawPort.port_id || rawPort.id);
  const deviceId = s(rawPort.device_id);
  const device = topo?.devices?.find(d => String(d.device_id) === String(deviceId));
  const name = s(rawPort.ifName) || s(rawPort.ifDescr) || s(rawPort.ifAlias) || portId;
  const alias = s(rawPort.ifAlias);
  const speedBps = typeof portSpeedBps === "function" ? portSpeedBps(rawPort) : n(rawPort.ifSpeed);

  return {
    portId,
    deviceId,
    deviceLabel: device?.label || s(rawPort.hostname) || deviceId,
    name,
    alias,
    label: alias && alias !== name ? `${name} - ${alias}` : name,
    speed: typeof speedLabel === "function" ? speedLabel(speedBps) : "",
    status: typeof normalizeOperStatus === "function"
      ? normalizeOperStatus(rawPort.ifOperStatus || rawPort.oper_status)
      : s(rawPort.ifOperStatus || rawPort.oper_status || "")
  };
}

async function netmapLookupArp(query) {
  const mac = netmapNormalizeMac(query);
  const routes = [`/api/v0/resources/ip/arp/${encodeURIComponent(query)}`];

  if (mac) {
    routes.push(`/api/v0/resources/ip/arp/${encodeURIComponent(mac.colon)}`);
    routes.push(`/api/v0/resources/ip/arp/${encodeURIComponent(mac.compact)}`);
  }

  for (const route of routes) {
    const data = await netmapTryGet(route);
    const rows = asArray(data, ["arp", "data", "results"]);
    if (rows.length) return rows;
  }

  return [];
}

async function netmapLookupFdb(macInput) {
  const mac = netmapNormalizeMac(macInput);
  if (!mac) return [];

  const routes = [
    `/api/v0/resources/fdb/${encodeURIComponent(mac.compact)}/detail`,
    `/api/v0/resources/fdb/${encodeURIComponent(mac.colon)}/detail`,
    `/api/v0/resources/fdb/${encodeURIComponent(mac.compact)}`,
    `/api/v0/resources/fdb/${encodeURIComponent(mac.colon)}`
  ];

  for (const route of routes) {
    const data = await netmapTryGet(route);
    const rows = asArray(data, ["ports_fdb", "fdb", "data", "results"]);
    if (rows.length) return rows;
  }

  return [];
}

function netmapRowMac(row) {
  const mac = netmapNormalizeMac(row.mac_address || row.mac || row.mac_address_raw || row.macAddress);
  return mac?.colon || s(row.mac_address || row.mac || row.macAddress);
}

function netmapRowIp(row) {
  return s(row.ipv4_address || row.ip || row.ip_address || row.address);
}

function netmapRowVlan(row) {
  return s(row.vlan || row.vlan_id || row.vlan_vlan || row.vlan_name);
}

function netmapRowLastSeen(row) {
  return s(row.last_seen || row.updated_at || row.last_updated || row.created_at || row.timestamp);
}

async function netmapHydrateArp(rows, topo) {
  const out = [];

  for (const row of rows) {
    const portId = s(row.port_id);
    const portInfo = netmapPortInfo(await netmapPortDetail(portId), topo);

    out.push({
      source: "ARP",
      ip: netmapRowIp(row),
      mac: netmapRowMac(row),
      vlan: netmapRowVlan(row),
      device: s(row.device_id || portInfo?.deviceId),
      deviceLabel: portInfo?.deviceLabel || s(row.hostname || row.device_id),
      hostname: s(row.hostname),
      port_id: portId,
      port: portInfo?.label || "",
      portAlias: portInfo?.alias || "",
      speed: portInfo?.speed || "",
      lastSeen: s(row.last_seen),
      updatedAt: netmapRowLastSeen(row),
      raw: row
    });
  }

  return out;
}

async function netmapHydrateFdb(rows, topo) {
  const out = [];

  for (const row of rows) {
    const portId = s(row.port_id);
    const portInfo = netmapPortInfo(await netmapPortDetail(portId), topo);

    out.push({
      source: "FDB",
      ip: netmapRowIp(row),
      mac: netmapRowMac(row),
      vlan: netmapRowVlan(row),
      device: s(row.device_id || row.hostname || row.device || portInfo?.deviceId),
      deviceLabel: portInfo?.deviceLabel || s(row.hostname || row.device || row.device_id),
      hostname: s(row.hostname),
      port_id: portId,
      port: s(row.ifName || row.ifDescr || row.ifAlias) || portInfo?.label || "",
      portAlias: s(row.ifAlias) || portInfo?.alias || "",
      speed: portInfo?.speed || "",
      lastSeen: s(row.last_seen),
      updatedAt: netmapRowLastSeen(row),
      raw: row
    });
  }

  return out;
}

function netmapDedupe(rows) {
  const seen = new Set();
  const out = [];

  for (const row of rows) {
    const key = [
      row.source,
      row.ip,
      row.mac,
      row.deviceLabel,
      row.port_id,
      row.port,
      row.vlan,
      row.lastSeen,
      row.updatedAt
    ].join("|");

    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }

  return out;
}

function netmapBestLocation(rows) {
  const fdb = rows.find(r => r.source === "FDB" && (r.port || r.port_id || r.deviceLabel));
  const arp = rows.find(r => r.source === "ARP" && (r.port || r.port_id || r.deviceLabel));
  const pick = fdb || arp;

  if (!pick) return null;

  return {
    device: pick.device,
    deviceLabel: pick.deviceLabel,
    port: pick.port,
    port_id: pick.port_id,
    vlan: pick.vlan,
    mac: pick.mac,
    ip: pick.ip,
    lastSeen: pick.lastSeen || pick.updatedAt,
    confidence: fdb ? "best FDB match" : "ARP match"
  };
}

app.get("/api/endpoint-search", async (req, res) => {
  const query = String(req.query.q || "").trim();

  if (!query) {
    return res.status(400).json({
      status: "error",
      message: "Missing query. Use ?q=IP, CIDR, or MAC."
    });
  }

  if (!netmapLooksLikeIpOrCidr(query) && !netmapLooksLikeMac(query)) {
    return res.status(400).json({
      status: "error",
      message: "Search must be an IP address, CIDR, or MAC address."
    });
  }

  try {
    const topo = await netmapTopology();
    let arpRows = [];
    let fdbRows = [];

    if (netmapLooksLikeIpOrCidr(query)) {
      arpRows = await netmapLookupArp(query);
      const macs = [...new Set(arpRows.map(r => netmapNormalizeMac(r.mac_address || r.mac)?.compact).filter(Boolean))];

      for (const mac of macs.slice(0, 50)) {
        fdbRows.push(...await netmapLookupFdb(mac));
      }
    } else {
      arpRows = await netmapLookupArp(query);
      fdbRows = await netmapLookupFdb(query);
    }

    const results = netmapDedupe([
      ...await netmapHydrateArp(arpRows, topo),
      ...await netmapHydrateFdb(fdbRows, topo)
    ]);

    res.json({
      status: "ok",
      query,
      count: results.length,
      location: netmapBestLocation(results),
      results
    });
  } catch (err) {
    res.status(502).json({
      status: "error",
      message: "Endpoint search failed.",
      detail: err.response?.data || err.message || String(err)
    });
  }
});

app.get("/api/client-location", async (req, res) => {
  const query = String(req.query.q || "").trim();

  if (!query) {
    return res.status(400).json({
      status: "error",
      message: "Missing query. Use ?q=IP or MAC."
    });
  }

  try {
    const fakeReq = { query: { q: query } };
    const topo = await netmapTopology();
    let arpRows = [];
    let fdbRows = [];

    if (netmapLooksLikeIpOrCidr(query)) {
      arpRows = await netmapLookupArp(query);
      const macs = [...new Set(arpRows.map(r => netmapNormalizeMac(r.mac_address || r.mac)?.compact).filter(Boolean))];
      for (const mac of macs.slice(0, 20)) fdbRows.push(...await netmapLookupFdb(mac));
    } else if (netmapLooksLikeMac(query)) {
      arpRows = await netmapLookupArp(query);
      fdbRows = await netmapLookupFdb(query);
    }

    const results = netmapDedupe([
      ...await netmapHydrateArp(arpRows, topo),
      ...await netmapHydrateFdb(fdbRows, topo)
    ]);

    res.json({
      status: "ok",
      query,
      location: netmapBestLocation(results),
      results
    });
  } catch (err) {
    res.status(502).json({
      status: "error",
      message: "Client location lookup failed.",
      detail: err.message || String(err)
    });
  }
});

app.get("/api/top-talkers", async (req, res) => {
  try {
    const topo = await netmapTopology();

    const devices = [...(topo.devices || [])]
      .map(d => ({
        id: d.id,
        label: d.label,
        role: d.role,
        vendor: d.vendor,
        inMbps: Number(d.trafficInMbps || 0),
        outMbps: Number(d.trafficOutMbps || 0),
        totalMbps: Number(d.trafficInMbps || 0) + Number(d.trafficOutMbps || 0),
        utilPct: 0
      }))
      .sort((a, b) => b.totalMbps - a.totalMbps)
      .slice(0, 10);

    const interfaces = [...(topo.ports || [])]
      .map(p => ({
        deviceLabel: p.device_label || p.device_id,
        name: p.name,
        alias: p.ifAlias,
        speed: p.speedLabel,
        inMbps: Number(p.inMbps || 0),
        outMbps: Number(p.outMbps || 0),
        totalMbps: Number(p.inMbps || 0) + Number(p.outMbps || 0),
        utilPct: Number(p.utilPct || 0)
      }))
      .sort((a, b) => b.totalMbps - a.totalMbps)
      .slice(0, 10);

    const links = [...(topo.links || [])]
      .map(l => ({
        localDevice: l.localDeviceLabel || l.source,
        remoteDevice: l.remoteDeviceLabel || l.target,
        localPort: l.localPortName,
        remotePort: l.remotePortName,
        speed: l.speedLabel,
        inMbps: Number(l.inMbps || 0),
        outMbps: Number(l.outMbps || 0),
        totalMbps: Number(l.inMbps || 0) + Number(l.outMbps || 0),
        utilPct: Number(l.utilPct || 0)
      }))
      .sort((a, b) => b.totalMbps - a.totalMbps)
      .slice(0, 10);

    res.json({
      status: "ok",
      generatedAt: topo.generatedAt,
      devices,
      interfaces,
      links
    });
  } catch (err) {
    res.status(502).json({
      status: "error",
      message: "Top talkers failed.",
      detail: err.message || String(err)
    });
  }
});

async function netmapSlackTickerItems() {
  if (String(process.env.SLACK_ENABLED || "false").toLowerCase() !== "true") return [];

  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID;
  if (!token || !channel) return [];

  try {
    const { data } = await axios.get("https://slack.com/api/conversations.history", {
      headers: { Authorization: `Bearer ${token}` },
      params: { channel, limit: 8 },
      timeout: 8000
    });

    if (!data.ok) return [];

    return (data.messages || []).slice(0, 8).map(m => ({
      source: "Slack",
      severity: "info",
      message: String(m.text || "").replace(/\s+/g, " ").slice(0, 220),
      timestamp: m.ts
    })).filter(i => i.message);
  } catch {
    return [];
  }
}

app.get("/api/ticker", async (req, res) => {
  try {
    const topo = await netmapTopology();
    const items = [];

    for (const alert of (topo.alerts || []).slice(0, 10)) {
      items.push({
        source: "LibreNMS",
        severity: String(alert.severity || "warning").toLowerCase(),
        message: `${alert.hostname || alert.device || alert.device_id || "device"}: ${alert.title || alert.rule || alert.name || "active alert"}`,
        timestamp: alert.timestamp || alert.time_logged || topo.generatedAt
      });
    }

    for (const device of (topo.devices || []).filter(d => d.status !== "up").slice(0, 8)) {
      items.push({
        source: "Device",
        severity: "critical",
        message: `${device.label} is ${device.status}`,
        timestamp: topo.generatedAt
      });
    }

    for (const link of (topo.links || []).filter(l => Number(l.utilPct || 0) >= 75).slice(0, 8)) {
      items.push({
        source: "Traffic",
        severity: Number(link.utilPct || 0) >= 90 ? "critical" : "warning",
        message: `${link.localDeviceLabel || link.source} to ${link.remoteDeviceLabel || link.target} at ${Number(link.utilPct || 0).toFixed(1)}%`,
        timestamp: topo.generatedAt
      });
    }

    items.push(...await netmapSlackTickerItems());

    res.json({
      status: "ok",
      generatedAt: new Date().toISOString(),
      count: items.length,
      items: items.slice(0, 25)
    });
  } catch (err) {
    res.status(502).json({
      status: "error",
      message: "Ticker failed.",
      detail: err.message || String(err)
    });
  }
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public/index.html")));

app.listen(PORT, "0.0.0.0", () => { console.log(`NetMap listening on http://0.0.0.0:${PORT}`); console.log(`Mode: ${MOCK_MODE}`); });
