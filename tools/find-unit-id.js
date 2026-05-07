"use strict";

const ModbusRTU = require("modbus-serial");

const host = process.argv[2] || "10.13.10.111";
const port = Number(process.argv[3] || 1502);
const startId = Number(process.argv[4] || 1);
const endId = Number(process.argv[5] || 10);

const client = new ModbusRTU();

async function tryUnit(unitId) {
  try {
    client.setID(unitId);
    const res = await client.readHoldingRegisters(40069 - 40001, 2);
    const [did, len] = res.data || [];
    if (Number.isFinite(did) && Number.isFinite(len)) {
      console.log(`Unit ${unitId}: reply DID=${did}, LEN=${len}`);
      return true;
    }
  } catch {
    // ignore non-responding IDs
  }
  return false;
}

async function run() {
  console.log(`Scanning Modbus TCP ${host}:${port}, unit IDs ${startId}..${endId}`);
  await client.connectTCP(host, { port });
  client.setTimeout(1500);

  const found = [];
  for (let unitId = startId; unitId <= endId; unitId++) {
    const ok = await tryUnit(unitId);
    if (ok) found.push(unitId);
  }

  if (found.length === 0) {
    console.log("No responding unit ID found in range.");
  } else {
    console.log(`Found unit IDs: ${found.join(", ")}`);
    console.log(`Recommended first try: ${found[0]}`);
  }

  await client.close();
}

run().catch(async (err) => {
  console.error(`Scan failed: ${err.message}`);
  try {
    if (client.isOpen) await client.close();
  } catch {
    // ignore
  }
  process.exit(1);
});
