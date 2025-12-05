const fs = require("fs");
const fetch = require("node-fetch");   // node-fetch@2
const express = require("express");

const app = express();
const PORT = 3000;

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

// ---- ÖBB MGATE ENDPOINT ----
const url = "https://fahrplan.oebb.at/gate";

// ---- STATIC PAYLOAD ----
const payload = {
  "id": "v34xpssuk4asggwg",
  "ver": "1.88",
  "lang": "deu",
  "auth": {
    "type": "AID",
    "aid": "5vHavmuWPWIfetEe"
  },
  "client": {
    "id": "OEBB",
    "type": "WEB",
    "name": "webapp",
    "l": "vs_webapp",
    "v": 21804
  },
  "formatted": false,
  "ext": "OEBB.14",
  "svcReqL": [
    {
      "meth": "JourneyGeoPos",
      "req": {
        "rect": {
          "llCrd": { "x": 10966662.744518988, "y": 46837834.50091163 },
          "urCrd": { "x": 19127978.662487734, "y": 48536792.19330821 }
        },
        "perSize": 35000,
        "perStep": 5000,
        "onlyRT": true,
        "jnyFltrL": [
          { "type": "PROD", "mode": "INC", "value": "4101" }
        ],
        "date": "20251205"
      },
      "id": "1|3|"
    }
  ]
};
//ll x et majd tedd vissza 15re

let unifiedCache = [];   // cached unified dataset
let lastUpdate = 0;

// ---------------------------
// FETCH + UNIFY FUNCTION
// ---------------------------
async function fetchOEBB() {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await res.json();

    fs.writeFileSync("raw_oebb.json", JSON.stringify(data, null, 2));

    const jnyL = data?.svcResL?.[0]?.res?.jnyL || [];
    const common = data?.svcResL?.[0]?.res?.common || {};
    const prodL = common?.prodL || [];

    // ---- Convert to unified format ----
const unified = [];

for (const j of jnyL) {
  const prod = prodL[j.prodX];
  const cat = prod?.prodCtx?.catOutL || "";

  // skip non-railjets
  if (cat !== "railjet xpress") continue;

  const nr = prod?.prodCtx?.matchId || "";
  const nextStop = j.stopL?.[2] || null;
  const lat = j.pos?.y / 1e6;
  const lon = j.pos?.x / 1e6;

  unified.push({
    vehicleId: "railjet",
    lat,
    lon,
    heading: (j.dirGeo)*90 ?? null,
    speed: 1,
    lastUpdated: Math.floor(Date.now() / 1000),
    nextStop: nextStop
      ? {
          arrivalDelay:
            nextStop.aTimeR && nextStop.aTimeS
              ? ((parseInt(nextStop.aTimeR) - parseInt(nextStop.aTimeS)) * 60) / 100
              : null
        }
      : null,
    tripShortName: j.prodX != null ? nr + " " + cat : null,
    tripHeadsign: j.dirTxt || null,
    routeShortName: "<span class=\"MNR2007\">&#481;</span>"
  });
}

    unifiedCache = unified;
    lastUpdate = Date.now();

    fs.writeFileSync("unified_oebb.json", JSON.stringify(unified, null, 2));

    console.log("✔ Updated ÖBB data (" + unified.length + " trains)");

  } catch (err) {
    console.error("❌ Fetch error:", err);
  }
}

// ---------------------------
// BACKGROUND UPDATER
// every 10 seconds
// ---------------------------
setInterval(fetchOEBB, 10_000);
fetchOEBB(); // run immediately on server start

// ---------------------------
// API ENDPOINT
// ---------------------------
app.get("/api/oebb", (req, res) => {
  res.json({
    data: unifiedCache
  });
});

// ---------------------------
// START SERVER
// ---------------------------
app.listen(PORT, () => {
  console.log(`🚄 Railway API running on http://localhost:${PORT}`);
});
