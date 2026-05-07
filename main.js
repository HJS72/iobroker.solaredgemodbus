"use strict";

const utils = require("@iobroker/adapter-core");
const ModbusRTU = require("modbus-serial");

const SUNSPEC_SF_MIN = -10;
const SUNSPEC_SF_MAX = 10;
const SUNSPEC_NOT_IMPL_INT16 = -32768;
const SUNSPEC_NOT_IMPL_UINT32 = 0xffffffff;
const REMOVED_STATES = ["Solaredge_Energie_Gesamt"];
const BATTERY_OPERATING_STATE_VALUES = [0, 1, 2, 3, 4, 5, 7];

const STATES = [
  { id: "Modbus_Status", role: "indicator.connected", type: "boolean" },
  {
    id: "Batterie_Betriebszustand",
    role: "value",
    type: "number",
    write: true,
    states: {
      "0": "Off",
      "1": "Standby",
      "2": "Init",
      "3": "Charge",
      "4": "Discharge",
      "5": "Fault",
      "7": "Idle",
    },
  },
  { id: "Batterie_Energie_max", unit: "Wh", role: "value.energy", decimals: 1 },
  { id: "Batterie_Leistung", unit: "W", role: "value.power", decimals: 1 },
  { id: "Batterie_SOC", unit: "%", role: "value.battery", decimals: 1 },
  { id: "Batterie_SOC_min", unit: "%", role: "value.battery", decimals: 1 },
  { id: "Batterie_Time", unit: "h", role: "value.interval", decimals: 2 },
  { id: "Batterie_Uhrzeit", role: "text", type: "string" },
  { id: "PV_Leistung", unit: "W", role: "value.power", decimals: 1 },
  { id: "PV_Energie_Gesamt", unit: "Wh", role: "value.energy", decimals: 1 },
  { id: "PV_Energie_Tag", unit: "Wh", role: "value.energy", decimals: 1 },
  { id: "Solaredge_Leistung", unit: "W", role: "value.power", decimals: 1 },
  { id: "Solaredge_Energie_Tag", unit: "Wh", role: "value.energy", decimals: 1 },
  { id: "Grid_Leistung", unit: "W", role: "value.power", decimals: 1 },
];

class Solaredgemodbus extends utils.Adapter {
  constructor(options = {}) {
    super({
      ...options,
      name: "solaredgemodbus",
    });

    this.client = new ModbusRTU();
    this.pollTimer = null;
    this.dayCache = {
      dateKey: "",
      minSoc: null,
      solaredgeDayWhIntegrated: 0,
      pvDayWhIntegrated: 0,
      lastSampleTs: null,
      lastSolaredgePower: null,
      lastPvPower: null,
    };
    this.formulaWarnings = new Set();
    this.invalidBatteryOperatingStateAddressWarned = false;
    this.legacyAddressWarnings = new Set();
    // Circuit-breaker: tracks consecutive timeouts per register block
    // Map<groupStart, { consecutiveErrors: number, skipUntil: number }>
    this.registerCircuitBreaker = new Map();
    // Cache of last successful raw register slices to avoid value flicker on transient timeouts.
    this.lastGoodRawByKey = new Map();

    this.on("ready", this.onReady.bind(this));
    this.on("unload", this.onUnload.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
  }

  async onReady() {
    await this.ensureStates();
    await this.ensureInfoConnectionObject();
    await this.cleanupRemovedStates();
    await this.setConnectionStatus(false);
    await this.pollOnce();
    const intervalSec = Math.max(1, Number(this.config.pollIntervalSec) || 1);
    this.pollTimer = setInterval(() => {
      this.pollOnce().catch((err) => this.log.warn(`pollOnce failed: ${err.message}`));
    }, intervalSec * 1000);
  }

  async onUnload(callback) {
    try {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
      }
      await this.setConnectionStatus(false);
      if (this.client.isOpen) {
        await this.client.close();
      }
      callback();
    } catch {
      callback();
    }
  }

  async ensureStates() {
    for (const s of STATES) {
      await this.setObjectNotExistsAsync(s.id, {
        type: "state",
        common: {
          name: s.id,
          type: s.type || "number",
          role: s.role,
          read: true,
          write: !!s.write,
          unit: s.unit,
          states: s.states,
        },
        native: {},
      });
    }
  }

  async ensureInfoConnectionObject() {
    await this.setObjectNotExistsAsync("info.connection", {
      type: "state",
      common: {
        name: "If adapter is connected",
        type: "boolean",
        role: "indicator.connected",
        read: true,
        write: false,
      },
      native: {},
    });
  }

  resolveAbsoluteAddress(address, registerName = "register") {
    const value = Number(address);
    if (!Number.isFinite(value)) {
      return null;
    }

    const intValue = Math.trunc(value);
    if (intValue >= 40001) {
      return intValue;
    }

    if (intValue >= 0) {
      const absolute = intValue + 40001;
      const warningKey = `${registerName}:${intValue}`;
      if (!this.legacyAddressWarnings.has(warningKey)) {
        this.legacyAddressWarnings.add(warningKey);
        this.log.warn(
          `Legacy zero-based address detected for ${registerName}: ${intValue}. Auto-converted to absolute ${absolute}.`,
        );
      }
      return absolute;
    }

    return null;
  }

  normalizeBatteryOperatingState(value) {
    if (!Number.isFinite(value)) {
      return null;
    }
    const state = Math.trunc(value);
    return BATTERY_OPERATING_STATE_VALUES.includes(state) ? state : null;
  }

  async onStateChange(id, state) {
    if (!state || state.ack) {
      return;
    }

    if (!id.endsWith(".Batterie_Betriebszustand")) {
      return;
    }

    const configuredRegisterAddress = Number(
      this.config.registers?.batteryOperatingState ?? this.config.registers?.write103237,
    ) || 103237;
    const registerAddress = this.resolveAbsoluteAddress(
      configuredRegisterAddress,
      "batteryOperatingState(write)",
    );
    if (!Number.isFinite(registerAddress)) {
      this.log.warn(
        `Batterie_Betriebszustand write skipped: invalid register address ${configuredRegisterAddress}`,
      );
      return;
    }
    const writeValue = this.normalizeBatteryOperatingState(Number(state.val));
    if (writeValue === null) {
      this.log.warn(`Batterie_Betriebszustand write ignored: invalid value ${state.val}`);
      return;
    }

    try {
      await this.ensureConnected();
      // uint32 big-endian word-swap: low word first, high word second.
      const lowWord = writeValue & 0xffff;
      const highWord = (writeValue >>> 16) & 0xffff;
      await this.client.writeRegisters(this.toOffset(registerAddress), [lowWord, highWord]);
      await this.setStateAsync("Batterie_Betriebszustand", { val: writeValue, ack: true });
      await this.setConnectionStatus(true);
      this.log.info(`Wrote register ${registerAddress} with value ${writeValue}`);
    } catch (err) {
      this.log.warn(`Write to register ${registerAddress} failed: ${err.message}`);
      await this.setConnectionStatus(false);
    }
  }

  async cleanupRemovedStates() {
    for (const id of REMOVED_STATES) {
      try {
        await this.delObjectAsync(id);
      } catch {
        // ignore if object does not exist
      }
    }
  }

  toOffset(address) {
    const absoluteAddress = this.resolveAbsoluteAddress(address);
    if (!Number.isFinite(absoluteAddress)) {
      throw new Error(`Invalid address: ${address}`);
    }

    return absoluteAddress - 40001;
  }

  round(value, decimals) {
    const f = 10 ** decimals;
    return Math.round(value * f) / f;
  }

  nowDateKey() {
    return new Date().toISOString().slice(0, 10);
  }

  formatLocalClock(ts) {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }

  calcBatteryTargetClock(batterySoc, batteryAcPower, batterySocMin, batteryEnergyMaxWh) {
    if (
      !Number.isFinite(batterySoc) ||
      !Number.isFinite(batteryAcPower) ||
      !Number.isFinite(batteryEnergyMaxWh) ||
      batteryEnergyMaxWh <= 0
    ) {
      return null;
    }

    const powerAbs = Math.abs(batteryAcPower);
    if (powerAbs < 1) {
      return null;
    }

    let deltaSoc = 0;
    if (batteryAcPower < 0) {
      deltaSoc = 100 - batterySoc;
    } else {
      const socMin = Number.isFinite(batterySocMin) ? batterySocMin : 0;
      deltaSoc = batterySoc - socMin;
    }

    if (!Number.isFinite(deltaSoc) || deltaSoc <= 0) {
      return this.formatLocalClock(Date.now());
    }

    const requiredWh = (batteryEnergyMaxWh * deltaSoc) / 100;
    const hours = requiredWh / powerAbs;
    if (!Number.isFinite(hours) || hours < 0) {
      return null;
    }

    return this.formatLocalClock(Date.now() + hours * 3600 * 1000);
  }

  applyScale(raw, sf, rawType = "number") {
    if (raw === null || raw === undefined || sf === null || sf === undefined) {
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

  // SolarEdge battery float32 registers are little-word-order float values.
  regsToFloat32LittleWord(reg1, reg2) {
    if (reg1 === null || reg1 === undefined || reg2 === null || reg2 === undefined) {
      return null;
    }
    const buf = Buffer.allocUnsafe(4);
    buf.writeUInt16BE(reg2 & 0xffff, 0);
    buf.writeUInt16BE(reg1 & 0xffff, 2);
    const n = buf.readFloatBE(0);
    if (!Number.isFinite(n)) {
      return null;
    }
    return n;
  }

  regsToUInt32(reg1, reg2) {
    if (reg1 === null || reg1 === undefined || reg2 === null || reg2 === undefined) {
      return null;
    }
    return (reg1 & 0xffff) * 65536 + (reg2 & 0xffff);
  }

  regsToUInt32WordSwap(reg1, reg2) {
    if (reg1 === null || reg1 === undefined || reg2 === null || reg2 === undefined) {
      return null;
    }
    return (reg2 & 0xffff) * 65536 + (reg1 & 0xffff);
  }

  regsToUInt64From4(regs) {
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

  regsToInt16(reg) {
    if (reg === null || reg === undefined) {
      return null;
    }
    const v = reg & 0xffff;
    return v > 0x7fff ? v - 0x10000 : v;
  }

  async readHolding(address, len) {
    const offset = this.toOffset(address);
    const res = await this.client.readHoldingRegisters(offset, len);
    return res.data;
  }

  buildReadPlan(registers) {
    const defs = [
      { key: "invPower", address: registers.inverterAcPower, len: 1 },
      { key: "invPowerSf", address: registers.inverterAcPowerSf, len: 1 },
      { key: "invEnergy", address: registers.inverterAcEnergyWh, len: 2 },
      { key: "invEnergySf", address: registers.inverterAcEnergyWhSf, len: 1 },
      { key: "meterPower", address: registers.meterAcPower, len: 1 },
      { key: "meterPowerSf", address: registers.meterAcPowerSf, len: 1 },
      { key: "battPower", address: registers.batteryDcPower, len: 2 },
      { key: "battEnergyMax", address: registers.batteryEnergyMax, len: 2 },
      { key: "battSoc", address: registers.batterySoc, len: 2 },
      { key: "battImport", address: registers.batteryImportEnergyWh, len: 4 },
      { key: "battExport", address: registers.batteryExportEnergyWh, len: 4 },
    ];

    const batteryOperatingStateAddress = Number(
      registers.batteryOperatingState ?? registers.write103237,
    );
    const batteryOperatingStateAbsoluteAddress = this.resolveAbsoluteAddress(
      batteryOperatingStateAddress,
      "batteryOperatingState(read)",
    );
    if (Number.isFinite(batteryOperatingStateAbsoluteAddress)) {
      defs.push({ key: "battOperatingState", address: batteryOperatingStateAbsoluteAddress, len: 2 });
      this.invalidBatteryOperatingStateAddressWarned = false;
    } else if (
      Number.isFinite(batteryOperatingStateAddress) &&
      !this.invalidBatteryOperatingStateAddressWarned
    ) {
      this.invalidBatteryOperatingStateAddressWarned = true;
      this.log.warn(
        `Skipping Batterie_Betriebszustand read: invalid register address ${batteryOperatingStateAddress}`,
      );
    }

    return defs.map((d) => ({
      ...d,
      offset: this.toOffset(d.address),
    }));
  }

  mergeReadPlan(defs) {
    const sorted = [...defs].sort((a, b) => a.offset - b.offset);
    const maxGroupLen = 120;
    // Keep value/SF pairs (e.g. 40207 + 40211) in one read block.
    const maxGap = 4;
    const groups = [];

    for (const item of sorted) {
      const itemEnd = item.offset + item.len - 1;
      const current = groups[groups.length - 1];

      if (!current) {
        groups.push({ start: item.offset, end: itemEnd, items: [item] });
        continue;
      }

      const gap = item.offset - current.end - 1;
      const nextEnd = Math.max(current.end, itemEnd);
      const nextLen = nextEnd - current.start + 1;

      if (gap <= maxGap && nextLen <= maxGroupLen) {
        current.end = nextEnd;
        current.items.push(item);
      } else {
        groups.push({ start: item.offset, end: itemEnd, items: [item] });
      }
    }

    return groups;
  }

  async readBatchedRegisters(registers) {
    const defs = this.buildReadPlan(registers);
    const groups = this.mergeReadPlan(defs);
    const out = {};
    const CIRCUIT_BREAK_AFTER = 3;
    const CIRCUIT_BREAK_MS = 5 * 60 * 1000; // 5 minutes
    const now = Date.now();

    for (const group of groups) {
      const cb = this.registerCircuitBreaker.get(group.start);
      if (cb && cb.skipUntil > now) {
        for (const item of group.items) {
          const cached = this.lastGoodRawByKey.get(item.key);
          out[item.key] = Array.isArray(cached) ? cached.slice() : Array(item.len).fill(null);
        }
        continue;
      }

      const len = group.end - group.start + 1;
      try {
        const res = await this.client.readHoldingRegisters(group.start, len);
        const data = res.data;

        // Successful read: reset circuit breaker
        this.registerCircuitBreaker.delete(group.start);

        for (const item of group.items) {
          const start = item.offset - group.start;
          const slice = data.slice(start, start + item.len);
          out[item.key] = slice;
          this.lastGoodRawByKey.set(item.key, slice.slice());
        }
      } catch (err) {
        const prev = this.registerCircuitBreaker.get(group.start) || { consecutiveErrors: 0, skipUntil: 0 };
        const next = { consecutiveErrors: prev.consecutiveErrors + 1, skipUntil: 0 };

        if (next.consecutiveErrors >= CIRCUIT_BREAK_AFTER) {
          next.skipUntil = now + CIRCUIT_BREAK_MS;
          this.log.warn(
            `Register block ${group.start}-${group.end} failed ${next.consecutiveErrors}x in a row (${err.message}). Pausing for 5 min.`,
          );
        } else {
          this.log.warn(`Skipping register block ${group.start}-${group.end}: ${err.message}`);
        }

        this.registerCircuitBreaker.set(group.start, next);
        for (const item of group.items) {
          const cached = this.lastGoodRawByKey.get(item.key);
          out[item.key] = Array.isArray(cached) ? cached.slice() : Array(item.len).fill(null);
        }
      }
    }

    return out;
  }

  evalFormula(stateId, context, fallbackValue) {
    const formulas = this.config.formulas || {};
    const expr = formulas[stateId];
    if (typeof expr !== "string" || !expr.trim()) {
      return fallbackValue;
    }

    try {
      const keys = Object.keys(context);
      const values = Object.values(context);
      const fn = new Function(...keys, `"use strict"; return (${expr});`);
      const result = fn(...values);
      if (result === null || result === undefined) {
        return null;
      }
      if (typeof result === "number" && Number.isFinite(result)) {
        return result;
      }
      return fallbackValue;
    } catch (err) {
      if (!this.formulaWarnings.has(stateId)) {
        this.log.warn(`Formula for ${stateId} invalid, using default. Error: ${err.message}`);
        this.formulaWarnings.add(stateId);
      }
      return fallbackValue;
    }
  }

  async ensureConnected() {
    if (this.client.isOpen) {
      return;
    }

    const host = this.config.host;
    const port = Number(this.config.port) || 1502;
    const unitId = Number(this.config.unitId) || 1;

    await this.client.connectTCP(host, { port });
    this.client.setID(unitId);
    this.client.setTimeout(4000);
  }

  async pollOnce() {
    try {
      await this.ensureConnected();

      const r = this.config.registers || {};
      const raw = await this.readBatchedRegisters(r);

      const invPowerRaw = this.regsToInt16(raw.invPower[0]);
      const invPowerSf = this.regsToInt16(raw.invPowerSf[0]);
      const inverterAcPower = this.applyScale(invPowerRaw, invPowerSf, "int16");

      const invEnergyRawRegs = raw.invEnergy;
      const invEnergyRaw = this.regsToUInt32(invEnergyRawRegs[0], invEnergyRawRegs[1]);
      const invEnergySf = this.regsToInt16(raw.invEnergySf[0]);
      const inverterEnergyWh = this.applyScale(invEnergyRaw, invEnergySf, "uint32");

      const gridPowerRaw = this.regsToInt16(raw.meterPower[0]);
      const gridPowerSf = this.regsToInt16(raw.meterPowerSf[0]);
      const gridPowerBase = this.applyScale(gridPowerRaw, gridPowerSf, "int16");
      let gridPower = gridPowerBase;
      if (this.config.invertGridPowerSign) {
        gridPower *= -1;
      }

      const battPowerRegs = raw.battPower;
      const batteryDcPower = this.regsToFloat32LittleWord(battPowerRegs[0], battPowerRegs[1]);

      const battEnergyMaxRegs = raw.battEnergyMax;
      const batteryEnergyMax = this.regsToFloat32LittleWord(battEnergyMaxRegs[0], battEnergyMaxRegs[1]);

      const battSocRegs = raw.battSoc;
      const batterySoc = this.regsToFloat32LittleWord(battSocRegs[0], battSocRegs[1]);
      let batteryEnergyAvailable = null;

      const batteryImportEnergyWh = raw.battImport ? this.regsToUInt64From4(raw.battImport) : null;
      const batteryExportEnergyWh = raw.battExport ? this.regsToUInt64From4(raw.battExport) : null;
      const batteryOperatingStateRaw = raw.battOperatingState
        ? this.regsToUInt32WordSwap(raw.battOperatingState[0], raw.battOperatingState[1])
        : null;
      const batteryOperatingState = BATTERY_OPERATING_STATE_VALUES.includes(batteryOperatingStateRaw)
        ? batteryOperatingStateRaw
        : null;

      const configuredSocMin = Number(this.config.batterySocMin);
      let batterySocMin = configuredSocMin > 0 ? configuredSocMin : undefined;

      const efficiency = Math.min(1, Math.max(0.5, Number(this.config.batteryAcEfficiency) || 0.96));
      const formulaCtx = {
        inverterAcPower,
        inverterEnergyWh,
        gridPower,
        gridPowerBase,
        batteryDcPower,
        batteryEnergyMax,
        batteryEnergyAvailable,
        batterySoc,
        batteryImportEnergyWh,
        batteryExportEnergyWh,
        batteryAcEfficiency: efficiency,
      };

      const batteryAcPowerDefault = batteryDcPower === null ? null : batteryDcPower * efficiency;
      const solaredgePower = this.evalFormula("Solaredge_Leistung", formulaCtx, inverterAcPower);
      const batteryAcPower = this.evalFormula("Batterie_Leistung", formulaCtx, batteryAcPowerDefault);
      gridPower = this.evalFormula("Grid_Leistung", { ...formulaCtx, solaredgePower, batteryAcPower }, gridPower);
      const pvPower = this.evalFormula(
        "PV_Leistung",
        { ...formulaCtx, solaredgePower, batteryAcPower, gridPower },
        inverterAcPower === null || batteryAcPower === null ? inverterAcPower : inverterAcPower - batteryAcPower,
      );
      const pvPowerOut =
        Number.isFinite(pvPower)
          ? pvPower
          : Number.isFinite(solaredgePower)
            ? solaredgePower
            : Number.isFinite(this.dayCache.lastPvPower)
              ? this.dayCache.lastPvPower
              : null;

      const pvEnergyTotal = this.evalFormula(
        "PV_Energie_Gesamt",
        { ...formulaCtx, batteryAcPower, pvPower: pvPowerOut },
        inverterEnergyWh,
      );
      const batteryEnergyMaxOut = this.evalFormula("Batterie_Energie_max", formulaCtx, batteryEnergyMax);
      const batterySocOut = this.evalFormula("Batterie_SOC", formulaCtx, batterySoc);

      const dateKey = this.nowDateKey();
      const nowTs = Date.now();
      if (this.dayCache.dateKey !== dateKey) {
        this.dayCache.dateKey = dateKey;
        this.dayCache.minSoc = batterySocOut;
        this.dayCache.solaredgeDayWhIntegrated = 0;
        this.dayCache.pvDayWhIntegrated = 0;
        this.dayCache.lastSampleTs = nowTs;
        this.dayCache.lastSolaredgePower =
          typeof solaredgePower === "number" && Number.isFinite(solaredgePower)
            ? solaredgePower
            : null;
        this.dayCache.lastPvPower =
          typeof pvPowerOut === "number" && Number.isFinite(pvPowerOut)
            ? pvPowerOut
            : null;
      } else {
        const prevTs = this.dayCache.lastSampleTs;
        const prevP = this.dayCache.lastSolaredgePower;
        const currP =
          typeof solaredgePower === "number" && Number.isFinite(solaredgePower)
            ? solaredgePower
            : null;
        const prevPv = this.dayCache.lastPvPower;
        const currPv =
          typeof pvPowerOut === "number" && Number.isFinite(pvPowerOut)
            ? pvPowerOut
            : null;

        if (prevTs && prevP !== null && currP !== null && nowTs > prevTs) {
          const dtSec = (nowTs - prevTs) / 1000;
          const avgPower = (prevP + currP) / 2;
          this.dayCache.solaredgeDayWhIntegrated += (avgPower * dtSec) / 3600;

          if (prevPv !== null && currPv !== null) {
            const avgPvPower = (prevPv + currPv) / 2;
            this.dayCache.pvDayWhIntegrated += (avgPvPower * dtSec) / 3600;
          }
        }

        this.dayCache.lastSampleTs = nowTs;
        this.dayCache.lastSolaredgePower = currP;
        this.dayCache.lastPvPower = currPv;
      }

      if (batterySocOut !== null) {
        if (this.dayCache.minSoc === null) {
          this.dayCache.minSoc = batterySocOut;
        } else {
          this.dayCache.minSoc = Math.min(this.dayCache.minSoc, batterySocOut);
        }
      }

      if (batterySocMin === undefined) {
        batterySocMin = this.dayCache.minSoc;
      }

      const solaredgeEnergyDayDefault =
        Number.isFinite(this.dayCache.solaredgeDayWhIntegrated)
          ? Math.max(0, this.dayCache.solaredgeDayWhIntegrated)
          : null;

      const pvEnergyDayDefault =
        Number.isFinite(this.dayCache.pvDayWhIntegrated)
          ? Math.max(0, this.dayCache.pvDayWhIntegrated)
          : null;

      const dayCtx = {
        ...formulaCtx,
        solaredgePower,
        batteryAcPower,
        pvPower: pvPowerOut,
        pvEnergyTotal,
      };

      const solaredgeEnergyDay = this.evalFormula(
        "Solaredge_Energie_Tag",
        dayCtx,
        solaredgeEnergyDayDefault,
      );
      const pvEnergyDayRaw = this.evalFormula("PV_Energie_Tag", dayCtx, pvEnergyDayDefault);
      const pvEnergyDay = Number.isFinite(pvEnergyDayRaw) ? pvEnergyDayRaw : pvEnergyDayDefault;

      batterySocMin = this.evalFormula("Batterie_SOC_min", { ...dayCtx, batterySocMin }, batterySocMin);
      if (
        Number.isFinite(batteryEnergyMaxOut) &&
        Number.isFinite(batterySocOut) &&
        Number.isFinite(batterySocMin)
      ) {
        const dischargeDeltaSoc = Math.max(0, batterySocOut - batterySocMin);
        batteryEnergyAvailable = (batteryEnergyMaxOut * dischargeDeltaSoc) / 100;
      }

      let batteryTime = null;
      if (
        batteryAcPower !== null &&
        Math.abs(batteryAcPower) > 1 &&
        batteryEnergyMaxOut !== null &&
        batteryEnergyAvailable !== null
      ) {
        if (batteryAcPower > 0) {
          batteryTime = batteryEnergyAvailable / batteryAcPower;
        } else {
          const chargeDeltaSoc = Math.max(0, 100 - batterySocOut);
          batteryTime = ((batteryEnergyMaxOut * chargeDeltaSoc) / 100) / Math.abs(batteryAcPower);
        }
      } else if (
        batteryAcPower !== null &&
        Math.abs(batteryAcPower) > 1 &&
        batteryEnergyMaxOut !== null &&
        batterySocOut !== null
      ) {
        if (batteryAcPower > 0 && batterySocMin !== null && batterySocMin !== undefined) {
          const dischargeDeltaSoc = Math.max(0, batterySocOut - batterySocMin);
          batteryTime = ((batteryEnergyMaxOut * dischargeDeltaSoc) / 100) / Math.abs(batteryAcPower);
        } else if (batteryAcPower < 0) {
          const chargeDeltaSoc = Math.max(0, 100 - batterySocOut);
          batteryTime = ((batteryEnergyMaxOut * chargeDeltaSoc) / 100) / Math.abs(batteryAcPower);
        }
      }
      batteryTime = this.evalFormula(
        "Batterie_Time",
        {
          ...dayCtx,
          batterySocMin,
          batteryEnergyMaxOut,
          batteryEnergyAvailable,
        },
        batteryTime,
      );
      const batteryTargetClock = this.calcBatteryTargetClock(
        batterySocOut,
        batteryAcPower,
        batterySocMin,
        batteryEnergyMaxOut,
      );

      await this.setNumberState("Batterie_Energie_max", batteryEnergyMaxOut, 1);
      await this.setNumberState("Batterie_Leistung", batteryAcPower, 1);
      await this.setNumberState("Batterie_SOC", batterySocOut, 1);
      await this.setNumberState("Batterie_SOC_min", batterySocMin, 1);
      await this.setNumberState("Batterie_Time", batteryTime, 2);
      await this.setStringState("Batterie_Uhrzeit", batteryTargetClock);
      await this.setNumberState("Batterie_Betriebszustand", batteryOperatingState, 0);

      await this.setNumberState("PV_Leistung", pvPowerOut, 1);
      await this.setNumberState("PV_Energie_Gesamt", pvEnergyTotal, 1);
      await this.setNumberState("PV_Energie_Tag", pvEnergyDay, 1);

      await this.setNumberState("Solaredge_Leistung", solaredgePower, 1);
      await this.setNumberState("Solaredge_Energie_Tag", solaredgeEnergyDay, 1);

      await this.setNumberState("Grid_Leistung", gridPower, 1);
      await this.setConnectionStatus(true);
    } catch (err) {
      this.log.warn(`Polling failed: ${err.message}`);
      await this.setConnectionStatus(false);
      if (this.client.isOpen) {
        try {
          await this.client.close();
        } catch {
          // ignore close errors
        }
      }
    }
  }

  async setNumberState(id, value, decimals) {
    if (value === null || value === undefined || !Number.isFinite(value)) {
      return;
    }
    await this.setStateAsync(id, { val: this.round(value, decimals), ack: true });
  }

  async setStringState(id, value) {
    if (typeof value !== "string" || !value) {
      return;
    }
    await this.setStateAsync(id, { val: value, ack: true });
  }

  async setConnectionStatus(connected) {
    await this.setStateAsync("Modbus_Status", { val: !!connected, ack: true });
    try {
      await this.setStateChangedAsync("info.connection", { val: !!connected, ack: true });
    } catch {
      // ignore if info.connection object is not available
    }
  }
}

if (require.main !== module) {
  module.exports = (options) => new Solaredgemodbus(options);
} else {
  new Solaredgemodbus();
}
