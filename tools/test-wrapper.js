"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawn } = require("child_process");
const ModbusRTU = require("modbus-serial");

const ROOT = path.resolve(__dirname, "..");
const defaultConfigPath = path.join(__dirname, "testwrapper.config.json");
const SUNSPEC_SF_MIN = -10;
const SUNSPEC_SF_MAX = 10;
const SUNSPEC_NOT_IMPL_INT16 = -32768;
const SUNSPEC_NOT_IMPL_UINT32 = 0xffffffff;
const configPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : defaultConfigPath;

if (!fs.existsSync(configPath)) {
  console.error(`Config not found: ${configPath}`);
  console.error(
    "Copy tools/testwrapper.config.example.json to tools/testwrapper.config.json and fill credentials.",
  );
  process.exit(1);
}

const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
const client = new ModbusRTU();
let adapterProc = null;
const localDayEnergy = {
  dateKey: "",
  wh: 0,
  lastTs: null,
  lastPower: null,
  seededDate: "",
};
const pvDayEnergy = {
  dateKey: "",
  wh: 0,
  lastTs: null,
  lastPower: null,
};
const lastGoodRawByKey = new Map();

function toOffset(address, addressMode) {
  if (addressMode === "zeroBased") {
    return Number(address);
  }
  return Number(address) - 40001;
}

function regsToInt16(reg) {
  if (reg === null || reg === undefined) {
    return null;
  }
  const v = reg & 0xffff;
  return v > 0x7fff ? v - 0x10000 : v;
}

function regsToUInt32(r1, r2) {
  if (r1 === null || r1 === undefined || r2 === null || r2 === undefined) {
    return null;
  }
  return (r1 & 0xffff) * 65536 + (r2 & 0xffff);
}

function regsToUInt64From4(regs) {
  if (!Array.isArray(regs) || regs.some((r) => r === null || r === undefined)) {
    return null;
  }
  const value =
    (BigInt(regs[0] & 0xffff) << 48n) |
    (BigInt(regs[1] & 0xffff) << 32n) |
    (BigInt(regs[2] & 0xffff) << 16n) |
    BigInt(regs[3] & 0xffff);
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (value > max) {
    return null;
  }
  return Number(value);
}

function regsToFloat32LittleWord(r1, r2) {
  if (r1 === null || r1 === undefined || r2 === null || r2 === undefined) {
    return null;
  }
  const buf = Buffer.allocUnsafe(4);
  buf.writeUInt16BE(r2 & 0xffff, 0);
  buf.writeUInt16BE(r1 & 0xffff, 2);
  const n = buf.readFloatBE(0);
  return Number.isFinite(n) ? n : null;
}

function applyScale(raw, sf, rawType = "number") {
  if (raw === null || sf === null || raw === undefined || sf === undefined) {
    return null;
  }

  if (sf === SUNSPEC_NOT_IMPL_INT16 || sf < SUNSPEC_SF_MIN || sf > SUNSPEC_SF_MAX) {
    return null;
  }

  if (rawType === "int16" && raw === SUNSPEC_NOT_IMPL_INT16) {
    return null;
  }

  if (rawType === "uint32" && raw === SUNSPEC_NOT_IMPL_UINT32) {
    return null;
  }

  const scaled = raw * 10 ** sf;
  return Number.isFinite(scaled) ? scaled : null;
}

function evalFormula(expr, context, fallbackValue) {
  if (!expr || typeof expr !== "string") {
    return fallbackValue;
  }
  try {
    const keys = Object.keys(context);
    const values = Object.values(context);
    const fn = new Function(...keys, `"use strict"; return (${expr});`);
    const value = fn(...values);
    return typeof value === "number" && Number.isFinite(value) ? value : fallbackValue;
  } catch {
    return fallbackValue;
  }
}

function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}

function integrateLocalDailyEnergy(solaredgePower) {
  const dateKey = todayYmd();
  const nowTs = Date.now();

  if (localDayEnergy.dateKey !== dateKey) {
    localDayEnergy.dateKey = dateKey;
    localDayEnergy.wh = 0;
    localDayEnergy.lastTs = nowTs;
    localDayEnergy.seededDate = "";
    localDayEnergy.lastPower =
      typeof solaredgePower === "number" && Number.isFinite(solaredgePower)
        ? solaredgePower
        : null;
    return localDayEnergy.wh;
  }

  const prevTs = localDayEnergy.lastTs;
  const prevP = localDayEnergy.lastPower;
  const currP =
    typeof solaredgePower === "number" && Number.isFinite(solaredgePower)
      ? solaredgePower
      : null;

  if (prevTs && prevP !== null && currP !== null && nowTs > prevTs) {
    const dtSec = (nowTs - prevTs) / 1000;
    const avgPower = (prevP + currP) / 2;
    localDayEnergy.wh += (avgPower * dtSec) / 3600;
  }

  localDayEnergy.lastTs = nowTs;
  localDayEnergy.lastPower = currP;

  return localDayEnergy.wh;
}

function seedLocalDailyEnergyFromCloud(cloudDayWh) {
  const dateKey = todayYmd();
  if (localDayEnergy.dateKey !== dateKey) {
    return;
  }
  if (!Number.isFinite(cloudDayWh)) {
    return;
  }
  if (localDayEnergy.seededDate === dateKey) {
    return;
  }

  localDayEnergy.wh = cloudDayWh;
  localDayEnergy.seededDate = dateKey;
}

function integratePvDailyEnergy(pvPower) {
  const dateKey = todayYmd();
  const nowTs = Date.now();

  if (pvDayEnergy.dateKey !== dateKey) {
    pvDayEnergy.dateKey = dateKey;
    pvDayEnergy.wh = 0;
    pvDayEnergy.lastTs = nowTs;
    pvDayEnergy.lastPower = typeof pvPower === "number" && Number.isFinite(pvPower) ? pvPower : null;
    return pvDayEnergy.wh;
  }

  const prevTs = pvDayEnergy.lastTs;
  const prevP = pvDayEnergy.lastPower;
  const currP = typeof pvPower === "number" && Number.isFinite(pvPower) ? pvPower : null;

  if (prevTs && prevP !== null && currP !== null && nowTs > prevTs) {
    const dtSec = (nowTs - prevTs) / 1000;
    const avgPower = (prevP + currP) / 2;
    pvDayEnergy.wh += (avgPower * dtSec) / 3600;
  }

  pvDayEnergy.lastTs = nowTs;
  pvDayEnergy.lastPower = currP;

  return pvDayEnergy.wh;
}

function formatLocalClock(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function calcBatteryTargetClock(batterySoc, batteryPower, batterySocMin, batteryEnergyMaxWh) {
  if (
    !Number.isFinite(batterySoc) ||
    !Number.isFinite(batteryPower) ||
    !Number.isFinite(batteryEnergyMaxWh) ||
    batteryEnergyMaxWh <= 0
  ) {
    return null;
  }

  const powerAbs = Math.abs(batteryPower);
  if (powerAbs < 1) {
    return null;
  }

  let deltaSoc = 0;
  if (batteryPower < 0) {
    deltaSoc = 100 - batterySoc;
  } else {
    const socMin = Number.isFinite(batterySocMin) ? batterySocMin : 0;
    deltaSoc = batterySoc - socMin;
  }

  if (!Number.isFinite(deltaSoc) || deltaSoc <= 0) {
    return formatLocalClock(Date.now());
  }

  const requiredWh = (batteryEnergyMaxWh * deltaSoc) / 100;
  const hours = requiredWh / powerAbs;
  if (!Number.isFinite(hours) || hours < 0) {
    return null;
  }

  return formatLocalClock(Date.now() + hours * 3600 * 1000);
}

function buildDefs(registers) {
  const defs = [
    { key: "invPower", address: registers.inverterAcPower, len: 1 },
    { key: "invPowerSf", address: registers.inverterAcPowerSf, len: 1 },
    { key: "invEnergy", address: registers.inverterAcEnergyWh, len: 2 },
    { key: "invEnergySf", address: registers.inverterAcEnergyWhSf, len: 1 },
    { key: "meterPower", address: registers.meterAcPower, len: 1 },
    { key: "meterPowerSf", address: registers.meterAcPowerSf, len: 1 },
    { key: "battPower", address: registers.batteryDcPower, len: 2 },
    { key: "battEnergyMax", address: registers.batteryEnergyMax, len: 2 },
    { key: "battEnergyAvail", address: registers.batteryEnergyAvailable, len: 2 },
    { key: "battSoc", address: registers.batterySoc, len: 2 },
  ];

  if (Number(registers.batterySocMin) > 0) {
    defs.push({ key: "battSocMin", address: registers.batterySocMin, len: 2 });
  }

  return defs;
}

async function readBatched(defs, addressMode) {
  const items = defs
    .map((d) => ({ ...d, offset: toOffset(d.address, addressMode) }))
    .sort((a, b) => a.offset - b.offset);

  const groups = [];
  const maxLen = 120;
  // Keep value/SF pairs in one read block to avoid mismatched scaling.
  const maxGap = 4;

  for (const item of items) {
    const end = item.offset + item.len - 1;
    const g = groups[groups.length - 1];
    if (!g) {
      groups.push({ start: item.offset, end, items: [item] });
      continue;
    }
    const gap = item.offset - g.end - 1;
    const nextEnd = Math.max(g.end, end);
    if (gap <= maxGap && nextEnd - g.start + 1 <= maxLen) {
      g.end = nextEnd;
      g.items.push(item);
    } else {
      groups.push({ start: item.offset, end, items: [item] });
    }
  }

  const out = {};
  for (const group of groups) {
    const len = group.end - group.start + 1;
    try {
      const res = await client.readHoldingRegisters(group.start, len);
      for (const item of group.items) {
        const idx = item.offset - group.start;
        const slice = res.data.slice(idx, idx + item.len);
        out[item.key] = slice;
        lastGoodRawByKey.set(item.key, slice.slice());
      }
    } catch {
      for (const item of group.items) {
        const cached = lastGoodRawByKey.get(item.key);
        out[item.key] = Array.isArray(cached) ? cached.slice() : Array(item.len).fill(null);
      }
    }
  }

  return out;
}

async function ensureConnected() {
  if (client.isOpen) {
    return;
  }
  await client.connectTCP(cfg.modbus.host, { port: Number(cfg.modbus.port) || 1502 });
  client.setID(Number(cfg.modbus.unitId) || 1);
  client.setTimeout(5000);
}

async function readLocal() {
  await ensureConnected();
  const r = cfg.modbus.registers;
  const raw = await readBatched(buildDefs(r), cfg.modbus.addressMode || "absolute40001");

  const inverterAcPower = applyScale(regsToInt16(raw.invPower[0]), regsToInt16(raw.invPowerSf[0]), "int16");
  const inverterEnergyWh = applyScale(
    regsToUInt32(raw.invEnergy[0], raw.invEnergy[1]),
    regsToInt16(raw.invEnergySf[0]),
    "uint32",
  );

  let gridPower = applyScale(regsToInt16(raw.meterPower[0]), regsToInt16(raw.meterPowerSf[0]), "int16");
  if (cfg.modbus.invertGridPowerSign) {
    gridPower *= -1;
  }

  const batteryDcPower = regsToFloat32LittleWord(raw.battPower[0], raw.battPower[1]);
  const batteryEnergyMax = regsToFloat32LittleWord(raw.battEnergyMax[0], raw.battEnergyMax[1]);
  const batteryEnergyAvailable = regsToFloat32LittleWord(raw.battEnergyAvail[0], raw.battEnergyAvail[1]);
  const batterySoc = regsToFloat32LittleWord(raw.battSoc[0], raw.battSoc[1]);
  const batterySocMin = raw.battSocMin
    ? regsToFloat32LittleWord(raw.battSocMin[0], raw.battSocMin[1])
    : null;


  const batteryAcEfficiency = Number(cfg.modbus.batteryAcEfficiency) || 0.96;
  const formulas = cfg.modbus.formulas || {};
  const context = {
    inverterAcPower,
    inverterEnergyWh,
    gridPower,
    batteryDcPower,
    batteryEnergyMax,
    batteryEnergyAvailable,
    batterySoc,
    batterySocMin,
    batteryAcEfficiency,
  };

  const batteryPower = evalFormula(
    formulas.Batterie_Leistung,
    context,
    batteryDcPower === null ? null : batteryDcPower * batteryAcEfficiency,
  );
  const solaredgePower = evalFormula(formulas.Solaredge_Leistung, { ...context, batteryPower }, inverterAcPower);
  const pvPower = evalFormula(
    formulas.PV_Leistung,
    { ...context, batteryPower, solaredgePower },
    inverterAcPower === null || batteryPower === null ? inverterAcPower : inverterAcPower - batteryPower,
  );
  const solaredgeEnergyTag = integrateLocalDailyEnergy(solaredgePower);
  const pvEnergyTag = integratePvDailyEnergy(pvPower);
  const batteryTargetClock = calcBatteryTargetClock(
    batterySoc,
    batteryPower,
    batterySocMin,
    batteryEnergyMax,
  );

  return {
    Modbus_Status: true,
    Batterie_Leistung: batteryPower,
    Batterie_Energie_max: batteryEnergyMax,
    Batterie_SOC: batterySoc,
    Batterie_SOC_min: batterySocMin,
    Batterie_Uhrzeit: batteryTargetClock,
    PV_Leistung: pvPower,
    PV_Energie_Gesamt: inverterEnergyWh,
    PV_Energie_Tag: pvEnergyTag,
    Solaredge_Energie_Tag: solaredgeEnergyTag,
    Solaredge_Leistung: solaredgePower,
    Grid_Leistung: gridPower,
  };
}

async function readCloud() {
  const cloud = cfg.cloud || {};
  if (!cloud.enabled) {
    return null;
  }

  const baseUrl = cloud.baseUrl || "https://monitoringapi.solaredge.com";
  const siteId = cloud.siteId;
  const apiKey = cloud.apiKey;
  const rejectUnauthorized = cloud.rejectUnauthorized !== false;
  const dailyEnergyType = cloud.dailyEnergyType || "Production";

  if (!siteId || !apiKey) {
    throw new Error("Cloud enabled but siteId/apiKey missing");
  }

  const [overview, flow, energyDetails] = await Promise.all([
    httpsGetJson(`${baseUrl}/site/${siteId}/overview?api_key=${apiKey}`, rejectUnauthorized),
    httpsGetJson(`${baseUrl}/site/${siteId}/currentPowerFlow?api_key=${apiKey}`, rejectUnauthorized),
    httpsGetJson(
      `${baseUrl}/site/${siteId}/energyDetails?startTime=${todayYmd()}%2000:00:00&endTime=${todayYmd()}%2023:59:59&timeUnit=DAY&api_key=${apiKey}`,
      rejectUnauthorized,
    ),
  ]);

  const meterByType = {};
  for (const meter of energyDetails?.energyDetails?.meters || []) {
    const type = meter?.type;
    const value = meter?.values?.[0]?.value;
    if (type && typeof value === "number") {
      meterByType[type] = value;
    }
  }

  const overviewLastDay = Number(overview.overview?.lastDayData?.energy);
  const selectedDaily =
    dailyEnergyType === "OverviewLastDay"
      ? overviewLastDay
      : meterByType[dailyEnergyType];

  return {
    overview: overview.overview,
    powerFlow: flow.siteCurrentPowerFlow,
    mapped: {
      Solaredge_Leistung:
        Number(overview.overview?.currentPower?.power) *
        (overview.overview?.currentPower?.unit === "kW" ? 1000 : 1),
      Solaredge_Energie_Tag:
        Number.isFinite(selectedDaily)
          ? selectedDaily * (energyDetails?.energyDetails?.unit === "kWh" ? 1000 : 1)
          : null,
      Grid_Leistung:
        Number(flow.siteCurrentPowerFlow?.GRID?.currentPower) * 1000,
      PV_Leistung:
        Number(flow.siteCurrentPowerFlow?.PV?.currentPower) * 1000,
      Batterie_Leistung:
        Number(flow.siteCurrentPowerFlow?.STORAGE?.currentPower) * 1000,
      Batterie_SOC: Number(flow.siteCurrentPowerFlow?.STORAGE?.chargeLevel),
      Solaredge_Energie_Tag_Source: dailyEnergyType,
    },
  };
}

function httpsGetJson(url, rejectUnauthorized) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        timeout: 10000,
        rejectUnauthorized,
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 180)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error(`Invalid JSON response: ${err.message}`));
          }
        });
      },
    );

    req.on("timeout", () => {
      req.destroy(new Error("Request timeout"));
    });
    req.on("error", (err) => reject(err));
  });
}

function startAdapterProcess() {
  const adapter = cfg.adapter || {};
  if (!adapter.enabled || !adapter.command) {
    return;
  }

  adapterProc = spawn(adapter.command, {
    cwd: adapter.cwd ? path.resolve(ROOT, adapter.cwd) : ROOT,
    shell: true,
    stdio: "inherit",
  });

  console.log(`Adapter process started: ${adapter.command}`);
}

function printCompare(local, cloud) {
  if (!cloud) {
    console.table(local);
    return;
  }

  const keys = [
    "Solaredge_Leistung",
    "PV_Leistung",
    "Grid_Leistung",
    "Batterie_Leistung",
    "Batterie_SOC",
    "Solaredge_Energie_Tag",
  ];

  const rows = keys.map((k) => {
    const localVal = local[k] ?? null;
    const cloudVal = cloud.mapped[k] ?? null;
    const delta =
      typeof localVal === "number" && typeof cloudVal === "number"
        ? localVal - cloudVal
        : null;
    return {
      key: k,
      local: localVal,
      cloud: cloudVal,
      delta,
    };
  });

  console.log(`\n${new Date().toISOString()} Compare`);
  console.table(rows);
}

function writeSnapshot(local, cloud, error) {
  const outDir = path.join(__dirname, "output");
  fs.mkdirSync(outDir, { recursive: true });
  const out = {
    ts: new Date().toISOString(),
    local,
    cloud,
    error: error || null,
  };
  fs.writeFileSync(path.join(outDir, "compare-latest.json"), JSON.stringify(out, null, 2));

  const historyNdjsonPath = path.join(outDir, "compare-history.ndjson");
  fs.appendFileSync(historyNdjsonPath, `${JSON.stringify(out)}\n`);

  const historyJsonPath = path.join(outDir, "compare-history.json");
  let history = [];
  if (fs.existsSync(historyJsonPath)) {
    try {
      history = JSON.parse(fs.readFileSync(historyJsonPath, "utf8"));
      if (!Array.isArray(history)) {
        history = [];
      }
    } catch {
      history = [];
    }
  }
  history.push(out);
  const keep = Math.max(100, Number(cfg.historyKeep) || 500);
  if (history.length > keep) {
    history = history.slice(history.length - keep);
  }
  fs.writeFileSync(historyJsonPath, JSON.stringify(history, null, 2));
}

async function loop() {
  try {
    const local = await readLocal();
    let cloud = null;
    try {
      cloud = await readCloud();
    } catch (err) {
      console.error(`Cloud read failed: ${err.message}`);
    }

    if (cloud?.mapped && Number.isFinite(cloud.mapped.Solaredge_Energie_Tag)) {
      seedLocalDailyEnergyFromCloud(cloud.mapped.Solaredge_Energie_Tag);
      local.Solaredge_Energie_Tag = localDayEnergy.wh;
    }

    printCompare(local, cloud);
    writeSnapshot(local, cloud, null);
  } catch (err) {
    console.error(`Loop failed: ${err.message}`);
    writeSnapshot({ Modbus_Status: false }, null, err.message);
  }
}

async function run() {
  startAdapterProcess();

  const interval = Math.max(5, Number(cfg.pollIntervalSec) || 30);
  await loop();
  const t = setInterval(loop, interval * 1000);

  process.on("SIGINT", async () => {
    clearInterval(t);
    try {
      if (client.isOpen) {
        await client.close();
      }
    } catch {
      // ignore close errors
    }
    if (adapterProc) {
      adapterProc.kill("SIGTERM");
    }
    process.exit(0);
  });
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
