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
      totalLinks: links.length, totalPorts: filteredPorts.length, upPorts: filteredPorts.filter(p => p.ifOperStatus === "up").length,
      downPorts: filteredPorts.filter(p => p.ifOperStatus && p.ifOperStatus !== "up").length,
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
    getJson("/api/v0/devices"), getJson("/api/v0/resources/links"), getJson(`/api/v0/ports?columns=${encodeURIComponent(portColumns)}`), getJson("/api/v0/alerts?state=1&order=timestamp%20DESC")
  ]);
  if (devicesPayload.status === "rejected") throw devicesPayload.reason;
  const rawDevices = asArray(devicesPayload.value, ["devices", "device"]);
  const rawLinks = linksPayload.status === "fulfilled" ? asArray(linksPayload.value, ["links"]) : [];
  const rawPorts = portsPayload.status === "fulfilled" ? asArray(portsPayload.value, ["ports", "port"]) : [];
  const rawAlerts = alertsPayload.status === "fulfilled" ? asArray(alertsPayload.value, ["alerts"]) : [];
  const devices = rawDevices.map(normalizeDevice).filter(d => d.role !== "exclude");
  const deviceById = new Map(devices.map(d => [d.device_id, d]));
  const ports = rawPorts.map(p => normalizePort(p, deviceById));
  const portById = new Map(ports.map(p => [p.port_id, p]));
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

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors());
app.use(morgan("combined"));
app.use(express.json());
app.use("/vendor/cytoscape.min.js", express.static(path.join(__dirname, "node_modules/cytoscape/dist/cytoscape.min.js")));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", async (req, res) => {
  if (MOCK_MODE === "true" || (MOCK_MODE === "auto" && !hasLiveConfig())) return res.json({ status:"ok", mode:"mock", message:"Running in mock mode.", configured:hasLiveConfig() });
  if (!hasLiveConfig()) return res.status(500).json({ status:"error", message:"Server is missing LIBRENMS_URL or LIBRENMS_TOKEN." });
  try { await getJson("/api/v0"); res.json({ status:"ok", mode:"live", librenms:LIBRENMS_URL }); } catch (err) { res.status(502).json({ status:"error", message:"Could not reach LibreNMS API.", detail:err.response?.data || err.message }); }
});
app.get("/api/topology", async (req, res) => { try { res.json(await currentTopology()); } catch (err) { res.status(502).json({ status:"error", message:"Could not build topology from LibreNMS.", detail:err.response?.data || err.message }); } });
app.get("/api/devices", async (req, res) => { try { const d = await currentTopology(); res.json({ status:"ok", generatedAt:d.generatedAt, devices:d.devices, summary:d.summary }); } catch (err) { res.status(502).json({ status:"error", message:err.message }); } });
app.get("/api/interfaces", async (req, res) => { try { const d = await currentTopology(); let ports = d.ports; const device = s(req.query.device), role = s(req.query.role); if (device) ports = ports.filter(p => p.device_id === device || p.device_label === device); if (role) ports = ports.filter(p => p.device_role === role); res.json({ status:"ok", generatedAt:d.generatedAt, interfaces:ports, summary:{ total:ports.length, up:ports.filter(p=>p.ifOperStatus==="up").length, down:ports.filter(p=>p.ifOperStatus && p.ifOperStatus!=="up").length, totalInMbps:ports.reduce((sum,p)=>sum+n(p.inMbps),0), totalOutMbps:ports.reduce((sum,p)=>sum+n(p.outMbps),0) } }); } catch (err) { res.status(502).json({ status:"error", message:err.message }); } });
app.get("/api/links", async (req, res) => { try { const d = await currentTopology(); res.json({ status:"ok", generatedAt:d.generatedAt, links:d.links, summary:{ total:d.links.length, totalInMbps:d.links.reduce((sum,l)=>sum+n(l.inMbps),0), totalOutMbps:d.links.reduce((sum,l)=>sum+n(l.outMbps),0) } }); } catch (err) { res.status(502).json({ status:"error", message:err.message }); } });
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public/index.html")));

app.listen(PORT, "0.0.0.0", () => { console.log(`NetMap listening on http://0.0.0.0:${PORT}`); console.log(`Mode: ${MOCK_MODE}`); });
