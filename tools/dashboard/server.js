"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");
const DASH_DIR = path.join(ROOT, "tools", "dashboard");
const OUT_DIR = path.join(ROOT, "tools", "output");
const CONFIG_PATH = path.join(ROOT, "tools", "testwrapper.config.json");
const PORT = Number(process.env.PORT || 8099);

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendFile(res, filePath, contentType) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  fs.createReadStream(filePath).pipe(res);
}

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function writeConfig(config) {
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer((req, res) => {
  const url = req.url || "/";

  if (url === "/" || url === "/index.html") {
    return sendFile(res, path.join(DASH_DIR, "index.html"), "text/html; charset=utf-8");
  }

  if (url === "/api/latest") {
    const p = path.join(OUT_DIR, "compare-latest.json");
    if (!fs.existsSync(p)) {
      return sendJson(res, 200, { ok: false, message: "No compare-latest.json yet" });
    }
    try {
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      return sendJson(res, 200, { ok: true, data });
    } catch (err) {
      return sendJson(res, 500, { ok: false, message: err.message });
    }
  }

  if (url === "/api/history") {
    const p = path.join(OUT_DIR, "compare-history.json");
    if (!fs.existsSync(p)) {
      return sendJson(res, 200, { ok: true, data: [] });
    }
    try {
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      return sendJson(res, 200, { ok: true, data: Array.isArray(data) ? data : [] });
    } catch (err) {
      return sendJson(res, 500, { ok: false, message: err.message });
    }
  }

  if (url === "/api/config" && req.method === "GET") {
    try {
      const config = readConfig();
      if (!config) {
        return sendJson(res, 404, { ok: false, message: "Config file not found" });
      }
      return sendJson(res, 200, { ok: true, data: config });
    } catch (err) {
      return sendJson(res, 500, { ok: false, message: err.message });
    }
  }

  if (url === "/api/config" && req.method === "POST") {
    readBody(req)
      .then((body) => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          sendJson(res, 400, { ok: false, message: "Invalid JSON body" });
          return;
        }

        if (!parsed || typeof parsed !== "object") {
          sendJson(res, 400, { ok: false, message: "Config must be an object" });
          return;
        }

        writeConfig(parsed);
        sendJson(res, 200, { ok: true, message: "Config saved" });
      })
      .catch((err) => {
        sendJson(res, 500, { ok: false, message: err.message });
      });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
