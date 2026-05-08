"use strict";

const utils = require("@iobroker/adapter-core");
const ModbusRTU = require("modbus-serial");

const SUNSPEC_SF_MIN = -10;
const SUNSPEC_SF_MAX = 10;
const SUNSPEC_NOT_IMPL_INT16 = -32768;
const SUNSPEC_NOT_IMPL_UINT32 = 0xffffffff;
const REMOVED_STATES = ["Grid_Energie_Gesamt", "Grid_Energie_Tag"];
const BATTERY_STORAGE_MODE_VALUES = [0, 1, 2, 4];

const STATES = [
  { id: "Modbus_Status", role: "indicator.connected", type: "boolean" },
  {
    id: "Batterie_Betriebsmodus",
    role: "value",
    type: "number",
    write: true,
    states: {
      "0": "Disabled",
      "1": "Maximize Self Consumption",
      "2": "Remote Control",
      "4": "Remote Control (Alternative)",
    },
  },
  { id: "Batterie_Energie_max", unit: "Wh", role: "value.energy", decimals: 1 },
  { id: "Batterie_Leistung", unit: "W", role: "value.power", decimals: 1 },
  { id: "Batterie_Energie_Gesamt", unit: "Wh", role: "value.energy", decimals: 1 },
  { id: "Batterie_Energie_Tag", unit: "Wh", role: "value.energy", decimals: 1 },
  { id: "Batterie_SOC", unit: "%", role: "value.battery", decimals: 1 },
  { id: "Batterie_SOC_min", unit: "%", role: "value.battery", decimals: 1 },
  { id: "Batterie_Time", unit: "h", role: "value.interval", decimals: 2 },
  { id: "Batterie_Uhrzeit", role: "text", type: "string" },
  { id: "PV_Leistung", unit: "W", role: "value.power", decimals: 1 },
  { id: "PV_Energie_Gesamt", unit: "Wh", role: "value.energy", decimals: 1 },
  { id: "PV_Energie_Tag", unit: "Wh", role: "value.energy", decimals: 1 },
  { id: "Solaredge_Leistung", unit: "W", role: "value.power", decimals: 1 },
  { id: "Solaredge_Energie_Gesamt", unit: "Wh", role: "value.energy", decimals: 1 },
  { id: "Solaredge_Energie_Tag", unit: "Wh", role: "value.energy", decimals: 1 },
  { id: "Grid_Leistung", unit: "W", role: "value.power", decimals: 1 },
  { id: "Grid_Bezug_Energie_Gesamt", unit: "Wh", role: "value.energy", decimals: 1 },
  { id: "Grid_Bezug_Energie_Tag", unit: "Wh", role: "value.energy", decimals: 1 },
  { id: "Grid_Einspeisung_Energie_Gesamt", unit: "Wh", role: "value.energy", decimals: 1 },
  { id: "Grid_Einspeisung_Energie_Tag", unit: "Wh", role: "value.energy", decimals: 1 },
];

class Solaredgemodbus extends utils.Adapter {
  constructor(options = {}) {
    super({
      ...options,
      name: "solaredgemodbus",
    });

    this.client = new ModbusRTU();
    this.pollTimer = null;
    this.pollInProgress = false;
    this.lastWriteTs = 0;
    this.dayCache = {
      dateKey: "",
      minSoc: null,
      solaredgeDayWhIntegrated: 0,
      pvDayWhIntegrated: 0,
      batteryDayWhIntegrated: 0,
      gridImportDayWhIntegrated: 0,
      gridExportDayWhIntegrated: 0,
      lastSampleTs: null,
      lastSolaredgePower: null,
      lastPvPower: null,
      lastBatteryAcPower: null,
      lastGridPower: null,
    };
    this.batteryEnergyTotal = 0;
    this.gridImportEnergyTotal = 0;
    this.gridExportEnergyTotal = 0;
    this.formulaWarnings = new Set();
    this.legacyAddressWarnings = new Set();
    this.diagnosticWarnings = new Set();
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
    
    // Subscribe to changes of Batterie_Betriebsmodus state
    this.subscribeStates("Batterie_Betriebsmodus");
    
    // Load persistent battery and grid total energy
    try {
      const batteryEnergyState = await this.getStateAsync("Batterie_Energie_Gesamt");
      if (batteryEnergyState && Number.isFinite(batteryEnergyState.val)) {
        this.batteryEnergyTotal = batteryEnergyState.val;
        this.log.debug(`Loaded persistent battery energy total: ${this.batteryEnergyTotal} Wh`);
      }

      const gridImportEnergyState = await this.getStateAsync("Grid_Bezug_Energie_Gesamt");
      if (gridImportEnergyState && Number.isFinite(gridImportEnergyState.val)) {
        this.gridImportEnergyTotal = gridImportEnergyState.val;
        this.log.debug(`Loaded persistent grid import energy total: ${this.gridImportEnergyTotal} Wh`);
      }

      const gridExportEnergyState = await this.getStateAsync("Grid_Einspeisung_Energie_Gesamt");
      if (gridExportEnergyState && Number.isFinite(gridExportEnergyState.val)) {
        this.gridExportEnergyTotal = gridExportEnergyState.val;
        this.log.debug(`Loaded persistent grid export energy total: ${this.gridExportEnergyTotal} Wh`);
      }
    } catch {
      this.log.warn("Failed to load persistent battery/grid import/grid export energy totals, starting from 0");
      this.batteryEnergyTotal = 0;
      this.gridImportEnergyTotal = 0;
      this.gridExportEnergyTotal = 0;
    }
    
    await this.setConnectionStatus(false);
    await this.runPollCycle();
    const intervalSec = Math.max(1, Number(this.config.pollIntervalSec) || 1);
    this.pollTimer = setInterval(() => {
      this.runPollCycle().catch((err) => this.log.warn(`poll cycle failed: ${err.message}`));
    }, intervalSec * 1000);
  }

  async runPollCycle() {
    if (this.pollInProgress) {
      return;
    }

    this.pollInProgress = true;
    try {
      await this.pollOnce();
    } finally {
      this.pollInProgress = false;
    }
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

  normalizeBatteryStorageMode(value) {
    if (!Number.isFinite(value)) {
      return null;
    }
    const state = Math.trunc(value);
    return BATTERY_STORAGE_MODE_VALUES.includes(state) ? state : null;
  }

  warnOnce(key, message, level = "warn") {
    if (this.diagnosticWarnings.has(key)) {
      return;
    }
    this.diagnosticWarnings.add(key);
    this.log[level](message);
  }

  logConfiguredRegistersOnce(registers) {
    if (this.diagnosticWarnings.has("configured-register-plan")) {
      return;
    }
    const entries = [
      ["inverterAcPower", registers.inverterAcPower],
      ["inverterAcPowerSf", registers.inverterAcPowerSf],
      ["inverterAcEnergyWh", registers.inverterAcEnergyWh],
      ["inverterAcEnergyWhSf", registers.inverterAcEnergyWhSf],
      ["meterAcPower", registers.meterAcPower],
      ["meterAcPowerSf", registers.meterAcPowerSf],
      ["batteryDcPower", registers.batteryDcPower],
      ["batteryEnergyMax", registers.batteryEnergyMax],
      ["batterySoc", registers.batterySoc],
      ["batteryOperatingState", registers.batteryOperatingState ?? registers.write103237],
    ]
      .map(([key, value]) => {
        const absolute = this.resolveAbsoluteAddress(value, key);
        const offset = Number.isFinite(absolute) ? absolute - 40001 : "invalid";
        return `${key}=${value} (absolute ${absolute}, offset ${offset})`;
      })
      .join(", ");
    this.diagnosticWarnings.add("configured-register-plan");
    this.log.info(`Configured Modbus register plan: ${entries}`);
  }

  async onStateChange(id, state) {
    const batteryModeStateId = `${this.namespace}.Batterie_Betriebsmodus`;
    this.log.silly(`[onStateChange] ALL changes: id=${id}, state=${JSON.stringify(state)}`);
    
    if (!state) {
      this.log.silly(`[onStateChange] Skipped: no state object`);
      return;
    }
    
    if (state.ack) {
      this.log.silly(`[onStateChange] Skipped: state.ack=true (id=${id})`);
      return;
    }

    if (id !== batteryModeStateId) {
      this.log.silly(`[onStateChange] Skipped: not target state (id=${id}, expected=${batteryModeStateId})`);
      return;
    }

    this.log.info(`Batterie_Betriebsmodus change detected: new value=${state.val}`);
    const configuredRegisterAddress = Number(
      this.config.registers?.batteryOperatingState ?? this.config.registers?.write103237,
    ) || 103237;
    this.log.debug(
      `Register config: batteryOperatingState=${this.config.registers?.batteryOperatingState}, write103237=${this.config.registers?.write103237}, resolved=${configuredRegisterAddress}`,
    );
    const registerAddress = this.resolveAbsoluteAddress(
      configuredRegisterAddress,
      "batteryOperatingState(write)",
    );
    if (!Number.isFinite(registerAddress)) {
      this.log.warn(
        `Batterie_Betriebsmodus write skipped: invalid register address ${configuredRegisterAddress}`,
      );
      return;
    }
    const writeValue = this.normalizeBatteryStorageMode(Number(state.val));
    if (writeValue === null) {
      this.log.warn(
        `Batterie_Betriebsmodus write ignored: invalid value ${state.val} (allowed: ${BATTERY_STORAGE_MODE_VALUES.join(", ")})`,
      );
      return;
    }
    this.log.debug(`Writing normalized value: ${state.val} -> ${writeValue}`);

    try {
      await this.ensureConnected();
      const writeIntervalMs = Math.max(0, Number(this.config.writeIntervalMs) || 100);
      const elapsedSinceLastWrite = Date.now() - this.lastWriteTs;
      if (elapsedSinceLastWrite < writeIntervalMs) {
        await this.waitMs(writeIntervalMs - elapsedSinceLastWrite);
      }
      const offset = this.toOffset(registerAddress);
      this.log.debug(
        `Writing Batterie_Betriebsmodus: registerAddress=${registerAddress}, offset=${offset}, value=${writeValue} (normalized from ${state.val})`,
      );
      const writeResult = await this.client.writeRegister(offset, writeValue & 0xffff);
      this.log.debug(`Write result for register ${registerAddress}: ${JSON.stringify(writeResult)}`);
      
      // Give device time to process the register write (important!)
      await this.waitMs(1000);
      
      this.lastWriteTs = Date.now();
      await this.setStateAsync("Batterie_Betriebsmodus", { val: writeValue, ack: true });
      await this.setConnectionStatus(true);
      this.log.info(`Wrote register ${registerAddress} with value ${writeValue} (ack after 1s delay)`);
    } catch (err) {
      this.log.error(
        `Write to register ${registerAddress} failed: ${err.message}`,
      );
      await this.setConnectionStatus(false);
    }
  }

  async cleanupRemovedStates() {
    for (const id of REMOVED_STATES) {
      try {
        await this.delStateAsync(id);
      } catch {
        // ignore if state value does not exist
      }
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

  async waitMs(ms) {
    if (!Number.isFinite(ms) || ms <= 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  calcBatteryTargetClock(batterySoc, batteryAcPower, batterySocMin, batteryEnergyMaxWh) {
    if (
      !Number.isFinite(batterySoc) ||
      !Number.isFinite(batteryAcPower) ||
      !Number.isFinite(batteryEnergyMaxWh) ||
      batteryEnergyMaxWh <= 0
    ) {
      this.log.debug(
        `[calcBatteryTargetClock] Early exit: batterySoc=${batterySoc}, batteryAcPower=${batteryAcPower}, batteryEnergyMaxWh=${batteryEnergyMaxWh}`,
      );
      return null;
    }

    const powerAbs = Math.abs(batteryAcPower);
    if (powerAbs < 1) {
      this.log.debug(`[calcBatteryTargetClock] Power too small (${batteryAcPower}W), returning null`);
      return null;
    }

    let deltaSoc = 0;
    if (batteryAcPower > 0) {
      // Positive power = charging
      deltaSoc = 100 - batterySoc;
    } else {
      // Negative power = discharging
      const socMin = Number.isFinite(batterySocMin) ? batterySocMin : 0;
      deltaSoc = batterySoc - socMin;
    }

    if (!Number.isFinite(deltaSoc) || deltaSoc <= 0) {
      this.log.debug(`[calcBatteryTargetClock] deltaSoc invalid or zero (${deltaSoc}%), returning now`);
      return this.formatLocalClock(Date.now());
    }

    const requiredWh = (batteryEnergyMaxWh * deltaSoc) / 100;
    const hours = requiredWh / powerAbs;
    const targetMs = Date.now() + hours * 3600 * 1000;
    const targetClock = this.formatLocalClock(targetMs);

    this.log.debug(
      `[calcBatteryTargetClock] batterySoc=${batterySoc}%, batteryAcPower=${batteryAcPower}W, ` +
        `batteryEnergyMaxWh=${batteryEnergyMaxWh}Wh, deltaSoc=${deltaSoc}%, requiredWh=${requiredWh.toFixed(0)}Wh, ` +
        `hours=${hours.toFixed(2)}h, target=${targetClock}`,
    );

    if (!Number.isFinite(hours) || hours < 0) {
      this.log.debug(`[calcBatteryTargetClock] Hours invalid (${hours}), returning null`);
      return null;
    }

    return targetClock;
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
    ];

    const batteryOperatingStateAddress = Number(
      registers.batteryOperatingState ?? registers.write103237,
    );
    const batteryOperatingStateAbsoluteAddress = this.resolveAbsoluteAddress(
      batteryOperatingStateAddress,
      "batteryOperatingState(read)",
    );
    if (Number.isFinite(batteryOperatingStateAbsoluteAddress)) {
      defs.push({ key: "batteryOperatingState", address: batteryOperatingStateAbsoluteAddress, len: 1 });
    } else if (Number.isFinite(batteryOperatingStateAddress)) {
      this.log.warn(
        `Skipping Batterie_Betriebsmodus read: invalid register address ${batteryOperatingStateAddress}`,
      );
    }

    return defs.map((d) => ({
      ...d,
      offset: this.toOffset(d.address),
    }));
  }

  mergeReadPlan(defs) {
    const sorted = [...defs].sort((a, b) => a.offset - b.offset);
    const maxGroupLen = Math.max(2, Math.min(120, Number(this.config.maxReadLen) || 40));
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
    const FATAL_ERROR_AFTER = 10;
    const OPTIONAL_BLOCK_QUARANTINE_MS = 24 * 60 * 60 * 1000; // 24 hours
    const readIntervalMs = Math.max(0, Number(this.config.readIntervalMs) || 150);
    const readRetryCount = Math.max(0, Math.min(10, Math.floor(Number(this.config.readRetryCount) || 1)));
    const now = Date.now();

    for (const group of groups) {
      const cb = this.registerCircuitBreaker.get(group.start);
      if (cb && cb.skipUntil > now) {
        for (const item of group.items) {
          const cached = this.lastGoodRawByKey.get(item.key);
          out[item.key] = Array.isArray(cached) ? cached.slice() : Array(item.len).fill(null);
        }
        await this.waitMs(readIntervalMs);
        continue;
      }

      const len = group.end - group.start + 1;
      let data = null;
      let lastErr = null;
      const maxAttempts = 1 + readRetryCount;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const res = await this.client.readHoldingRegisters(group.start, len);
          data = res.data;
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (attempt < maxAttempts) {
            await this.waitMs(50);
          }
        }
      }

      if (!lastErr) {
        // Successful read: reset circuit breaker
        this.registerCircuitBreaker.delete(group.start);

        for (const item of group.items) {
          const start = item.offset - group.start;
          const slice = data.slice(start, start + item.len);
          out[item.key] = slice;
          this.lastGoodRawByKey.set(item.key, slice.slice());
        }
        await this.waitMs(readIntervalMs);
      } else {
        const err = lastErr;
        const prev = this.registerCircuitBreaker.get(group.start) || { consecutiveErrors: 0, skipUntil: 0 };
        const next = { consecutiveErrors: prev.consecutiveErrors + 1, skipUntil: 0 };
        const isOptionalBatteryOnlyGroup = group.items.every((item) =>
          ["battPower", "battEnergyMax", "battSoc", "batteryOperatingState"].includes(item.key),
        );

        if (next.consecutiveErrors >= FATAL_ERROR_AFTER && !isOptionalBatteryOnlyGroup) {
          const itemList = group.items.map((i) => `${i.key}(${i.address})`).join(", ");
          this.registerCircuitBreaker.set(group.start, next);
          throw new Error(
            `Fatal register config error: block ${group.start}-${group.end} (${itemList}) unreachable after ` +
              `${FATAL_ERROR_AFTER} attempts (${err.message})`,
          );
        } else if (next.consecutiveErrors >= FATAL_ERROR_AFTER && isOptionalBatteryOnlyGroup) {
          next.skipUntil = now + OPTIONAL_BLOCK_QUARANTINE_MS;
          const itemList = group.items.map((i) => `${i.key}(${i.address})`).join(", ");
          this.log.warn(
            `Optional battery block ${group.start}-${group.end} (${itemList}) unreachable after ${FATAL_ERROR_AFTER} attempts ` +
              `(${err.message}). Disabling this block for 24h.`,
          );
        } else if (next.consecutiveErrors >= CIRCUIT_BREAK_AFTER) {
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
        await this.waitMs(readIntervalMs);
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
    const timeoutMs = Math.max(1000, Number(this.config.modbusTimeoutMs) || 7000);

    await this.client.connectTCP(host, { port });
    this.client.setID(unitId);
    this.client.setTimeout(timeoutMs);
  }

  async pollOnce() {
    try {
      await this.ensureConnected();

      const r = this.config.registers || {};
      this.logConfiguredRegistersOnce(r);
      const raw = await this.readBatchedRegisters(r);
      const rawSlice = (key, len) =>
        Array.isArray(raw[key]) && raw[key].length >= len ? raw[key] : Array(len).fill(null);

      const invPowerRegs = rawSlice("invPower", 1);
      const invPowerSfRegs = rawSlice("invPowerSf", 1);
      const invPowerRaw = this.regsToInt16(invPowerRegs[0]);
      const invPowerSf = this.regsToInt16(invPowerSfRegs[0]);
      const inverterAcPower = this.applyScale(invPowerRaw, invPowerSf, "int16");
      if (!Number.isFinite(inverterAcPower)) {
        this.warnOnce(
          "inverter-power-null",
          `Solaredge_Leistung unresolved: inverterAcPower register=${r.inverterAcPower}, sfRegister=${r.inverterAcPowerSf}, raw=${invPowerRegs[0]}, rawScaled=${invPowerRaw}, sf=${invPowerSf}`,
        );
      }

      const invEnergyRawRegs = rawSlice("invEnergy", 2);
      const invEnergyRaw = this.regsToUInt32(invEnergyRawRegs[0], invEnergyRawRegs[1]);
      const invEnergySfRegs = rawSlice("invEnergySf", 1);
      const invEnergySf = this.regsToInt16(invEnergySfRegs[0]);
      const inverterEnergyWh = this.applyScale(invEnergyRaw, invEnergySf, "uint32");
      if (!Number.isFinite(inverterEnergyWh)) {
        this.warnOnce(
          "inverter-energy-null",
          `Solaredge_Energie_Tag input unresolved: inverterAcEnergyWh register=${r.inverterAcEnergyWh}, sfRegister=${r.inverterAcEnergyWhSf}, raw=[${invEnergyRawRegs.join(", ")}], rawScaled=${invEnergyRaw}, sf=${invEnergySf}`,
        );
      }

      const meterPowerRegs = rawSlice("meterPower", 1);
      const meterPowerSfRegs = rawSlice("meterPowerSf", 1);
      const gridPowerRaw = this.regsToInt16(meterPowerRegs[0]);
      const gridPowerSf = this.regsToInt16(meterPowerSfRegs[0]);
      const gridPowerBase = this.applyScale(gridPowerRaw, gridPowerSf, "int16");
      let gridPower = gridPowerBase;
      if (this.config.invertGridPowerSign) {
        gridPower *= -1;
      }

      const battPowerRegs = rawSlice("battPower", 2);
      const batteryDcPower = this.regsToFloat32LittleWord(battPowerRegs[0], battPowerRegs[1]);

      const battEnergyMaxRegs = rawSlice("battEnergyMax", 2);
      const batteryEnergyMax = this.regsToFloat32LittleWord(battEnergyMaxRegs[0], battEnergyMaxRegs[1]);

      const battSocRegs = rawSlice("battSoc", 2);
      const batterySoc = this.regsToFloat32LittleWord(battSocRegs[0], battSocRegs[1]);
      let batteryEnergyAvailable = null;

      const batteryOperatingStateRegs = rawSlice("batteryOperatingState", 1);
      const batteryOperatingStateRaw = batteryOperatingStateRegs[0];
      const batteryStorageMode = BATTERY_STORAGE_MODE_VALUES.includes(batteryOperatingStateRaw)
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
        batteryAcEfficiency: efficiency,
      };

      const batteryAcPowerDefault = batteryDcPower === null ? null : batteryDcPower * efficiency;
      let solaredgePower = this.evalFormula("Solaredge_Leistung", formulaCtx, inverterAcPower);
      let batteryAcPower = this.evalFormula("Batterie_Leistung", formulaCtx, batteryAcPowerDefault);
      gridPower = this.evalFormula("Grid_Leistung", { ...formulaCtx, solaredgePower, batteryAcPower }, gridPower);
      let pvPower = this.evalFormula(
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
      const solaredgeEnergyTotalDefault = Number.isFinite(inverterEnergyWh)
        ? Math.max(0, inverterEnergyWh)
        : null;
      const solaredgeEnergyTotal = this.evalFormula(
        "Solaredge_Energie_Gesamt",
        { ...formulaCtx, batteryAcPower, pvPower: pvPowerOut, pvEnergyTotal },
        solaredgeEnergyTotalDefault,
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
        this.dayCache.batteryDayWhIntegrated = 0;
        this.dayCache.gridImportDayWhIntegrated = 0;
        this.dayCache.gridExportDayWhIntegrated = 0;
        this.dayCache.lastSampleTs = nowTs;
        // Set lastPower values only if current measurements are valid (not null), so integration can start
        if (typeof solaredgePower === "number" && Number.isFinite(solaredgePower)) {
          this.dayCache.lastSolaredgePower = solaredgePower;
        }
        if (typeof pvPowerOut === "number" && Number.isFinite(pvPowerOut)) {
          this.dayCache.lastPvPower = pvPowerOut;
        }
        if (typeof batteryAcPower === "number" && Number.isFinite(batteryAcPower)) {
          this.dayCache.lastBatteryAcPower = batteryAcPower;
        }
        if (typeof gridPower === "number" && Number.isFinite(gridPower)) {
          this.dayCache.lastGridPower = gridPower;
        }
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
        const prevBatt = this.dayCache.lastBatteryAcPower;
        const currBatt =
          typeof batteryAcPower === "number" && Number.isFinite(batteryAcPower)
            ? batteryAcPower
            : null;
        const prevGrid = this.dayCache.lastGridPower;
        const currGrid =
          typeof gridPower === "number" && Number.isFinite(gridPower)
            ? gridPower
            : null;

        if (prevTs && nowTs > prevTs) {
          const dtSec = (nowTs - prevTs) / 1000;
          if (prevP !== null && currP !== null) {
            const avgPower = (prevP + currP) / 2;
            this.dayCache.solaredgeDayWhIntegrated += (avgPower * dtSec) / 3600;
          }

          if (prevPv !== null && currPv !== null) {
            const avgPvPower = (prevPv + currPv) / 2;
            this.dayCache.pvDayWhIntegrated += (avgPvPower * dtSec) / 3600;
          }

          // Integrate battery discharge energy (only positive/discharge values)
          if (prevBatt !== null && currBatt !== null && (prevBatt > 0 || currBatt > 0)) {
            const avgBattPower = Math.max(0, (prevBatt + currBatt) / 2);
            const battWhDelta = (avgBattPower * dtSec) / 3600;
            this.dayCache.batteryDayWhIntegrated += battWhDelta;
            this.batteryEnergyTotal += battWhDelta;
          }

          // Integrate grid energy split by sign:
          // negative power -> import (Bezug), positive power -> export (Einspeisung).
          if (prevGrid !== null && currGrid !== null) {
            const avgGridImportPower = (Math.max(0, -prevGrid) + Math.max(0, -currGrid)) / 2;
            const avgGridExportPower = (Math.max(0, prevGrid) + Math.max(0, currGrid)) / 2;
            const gridImportWhDelta = (avgGridImportPower * dtSec) / 3600;
            const gridExportWhDelta = (avgGridExportPower * dtSec) / 3600;
            this.dayCache.gridImportDayWhIntegrated += gridImportWhDelta;
            this.dayCache.gridExportDayWhIntegrated += gridExportWhDelta;
            this.gridImportEnergyTotal += gridImportWhDelta;
            this.gridExportEnergyTotal += gridExportWhDelta;
          }
        }

        this.dayCache.lastSampleTs = nowTs;
        this.dayCache.lastSolaredgePower = currP;
        this.dayCache.lastPvPower = currPv;
        this.dayCache.lastBatteryAcPower = currBatt;
        this.dayCache.lastGridPower = currGrid;
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

      const gridImportEnergyDayDefault =
        Number.isFinite(this.dayCache.gridImportDayWhIntegrated)
          ? Math.max(0, this.dayCache.gridImportDayWhIntegrated)
          : null;

      const gridExportEnergyDayDefault =
        Number.isFinite(this.dayCache.gridExportDayWhIntegrated)
          ? Math.max(0, this.dayCache.gridExportDayWhIntegrated)
          : null;

      const gridImportEnergyTotalDefault =
        Number.isFinite(this.gridImportEnergyTotal)
          ? Math.max(0, this.gridImportEnergyTotal)
          : null;

      const gridExportEnergyTotalDefault =
        Number.isFinite(this.gridExportEnergyTotal)
          ? Math.max(0, this.gridExportEnergyTotal)
          : null;

      const dayCtx = {
        ...formulaCtx,
        solaredgePower,
        batteryAcPower,
        pvPower: pvPowerOut,
        pvEnergyTotal,
        solaredgeEnergyTotal,
        gridImportEnergyTotal: gridImportEnergyTotalDefault,
        gridImportEnergyDay: gridImportEnergyDayDefault,
        gridExportEnergyTotal: gridExportEnergyTotalDefault,
        gridExportEnergyDay: gridExportEnergyDayDefault,
      };

      const solaredgeEnergyDay = this.evalFormula(
        "Solaredge_Energie_Tag",
        dayCtx,
        solaredgeEnergyDayDefault,
      );

      const gridImportEnergyTotalRaw = this.evalFormula(
        "Grid_Bezug_Energie_Gesamt",
        dayCtx,
        gridImportEnergyTotalDefault,
      );
      const gridImportEnergyTotal = Number.isFinite(gridImportEnergyTotalRaw)
        ? gridImportEnergyTotalRaw
        : gridImportEnergyTotalDefault;
      if (Number.isFinite(gridImportEnergyTotal)) {
        this.gridImportEnergyTotal = gridImportEnergyTotal;
      }

      const gridImportEnergyDayRaw = this.evalFormula(
        "Grid_Bezug_Energie_Tag",
        dayCtx,
        gridImportEnergyDayDefault,
      );
      const gridImportEnergyDay = Number.isFinite(gridImportEnergyDayRaw)
        ? gridImportEnergyDayRaw
        : gridImportEnergyDayDefault;

      const gridExportEnergyTotalRaw = this.evalFormula(
        "Grid_Einspeisung_Energie_Gesamt",
        dayCtx,
        gridExportEnergyTotalDefault,
      );
      const gridExportEnergyTotal = Number.isFinite(gridExportEnergyTotalRaw)
        ? gridExportEnergyTotalRaw
        : gridExportEnergyTotalDefault;
      if (Number.isFinite(gridExportEnergyTotal)) {
        this.gridExportEnergyTotal = gridExportEnergyTotal;
      }

      const gridExportEnergyDayRaw = this.evalFormula(
        "Grid_Einspeisung_Energie_Tag",
        dayCtx,
        gridExportEnergyDayDefault,
      );
      const gridExportEnergyDay = Number.isFinite(gridExportEnergyDayRaw)
        ? gridExportEnergyDayRaw
        : gridExportEnergyDayDefault;

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
      let batteryTargetClock = this.calcBatteryTargetClock(
        batterySocOut,
        batteryAcPower,
        batterySocMin,
        batteryEnergyMaxOut,
      );

      // If battery is neutral (not charging or discharging), set time values to 0/"" 
      if (batteryAcPower === null || Math.abs(batteryAcPower) <= 1) {
        batteryTime = 0;
        batteryTargetClock = "";
      }

      await this.setNumberState("Batterie_Energie_max", batteryEnergyMaxOut, 1);
      await this.setNumberState("Batterie_Leistung", batteryAcPower, 1);
      await this.setNumberState("Batterie_Energie_Gesamt", this.batteryEnergyTotal, 1);
      await this.setNumberState("Batterie_Energie_Tag", this.dayCache.batteryDayWhIntegrated, 1);
      await this.setNumberState("Batterie_SOC", batterySocOut, 1);
      await this.setNumberState("Batterie_SOC_min", batterySocMin, 1);
      await this.setNumberState("Batterie_Time", batteryTime, 2);
      await this.setStringState("Batterie_Uhrzeit", batteryTargetClock);
      await this.setNumberState("Batterie_Betriebsmodus", batteryStorageMode, 0);

      await this.setNumberState("PV_Leistung", pvPowerOut, 1);
      await this.setNumberState("PV_Energie_Gesamt", pvEnergyTotal, 1);
      await this.setNumberState("PV_Energie_Tag", pvEnergyDay, 1);

      await this.setNumberState("Solaredge_Leistung", solaredgePower, 1);
      await this.setNumberState("Solaredge_Energie_Gesamt", solaredgeEnergyTotal, 1);
      await this.setNumberState("Solaredge_Energie_Tag", solaredgeEnergyDay, 1);

      await this.setNumberState("Grid_Leistung", gridPower, 1);
      await this.setNumberState("Grid_Bezug_Energie_Gesamt", gridImportEnergyTotal, 1);
      await this.setNumberState("Grid_Bezug_Energie_Tag", gridImportEnergyDay, 1);
      await this.setNumberState("Grid_Einspeisung_Energie_Gesamt", gridExportEnergyTotal, 1);
      await this.setNumberState("Grid_Einspeisung_Energie_Tag", gridExportEnergyDay, 1);
      await this.setConnectionStatus(true);
    } catch (err) {
      if (String(err.message || "").startsWith("Fatal register config error:")) {
        this.log.error(err.message);
        await this.setConnectionStatus(false);
        this.terminate(err.message);
        return;
      }
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
