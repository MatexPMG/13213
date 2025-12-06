const express = require("express");
const fs = require("fs");
const fetch = require("node-fetch"); // node-fetch@2
const app = express();
const port = 3000;

const oebbUrl = "https://fahrplan.oebb.at/gate";
const today = new Date().toISOString().split("T")[0].replace(/-/g, "");

// --- ÖBB payload ---
const oebbPayload = {
  id: "v34xpssuk4asggwg",
  ver: "1.88",
  lang: "eng",
  auth: { type: "AID", aid: "5vHavmuWPWIfetEe" },
  client: { id: "OEBB", type: "WEB", name: "webapp", l: "vs_webapp", v: 21804 },
  formatted: false,
  ext: "OEBB.14",
  svcReqL: [
    {
      meth: "JourneyGeoPos",
      req: {
        rect: {
          llCrd: { x: 17104947.509765629, y: 47407892.06010505 },
          urCrd: { x: 19135605.468750004, y: 47948232.33587184 }
        },
        perSize: 35000,
        perStep: 5000,
        onlyRT: true,
        jnyFltrL: [{ type: "PROD", mode: "INC", value: "4101" }],
        date: today
      },
      id: "1|3|"
    }
  ]
};

// --- Utility functions ---
function secondsSinceMidnight(isoStr) {
  if (!isoStr) return null;
  const d = new Date(isoStr);
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
}

function hhmmssToSeconds(hms) {
  if (!hms) return null;
  const h = parseInt(hms.slice(0, 2), 10);
  const m = parseInt(hms.slice(2, 4), 10);
  const s = parseInt(hms.slice(4, 6), 10);
  return h * 3600 + m * 60 + s;
}

// --- Fetch MAV timetable ---
async function fetchMAVTimetable(trainNumber) {
  const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0] + "T23:00:00.000Z";
  const payload = {
    type: "TrainInfo",
    travelDate: yesterday,
    minCount: "0",
    maxCount: "9999999",
    trainNumber: trainNumber
  };
  const res = await fetch("https://jegy-a.mav.hu/IK_API_PROD/api/InformationApi/GetTimetable", {
    method: "POST",
    headers: { "Content-Type": "application/json", usersessionid: "a2" },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  return data?.trainSchedulerDetails?.[0]?.scheduler || [];
}

// --- Fetch and merge ÖBB + MAV data ---
let unifiedData = { data: { vehiclePositions: [] } };

async function fetchOEBB() {
  try {
    const res = await fetch(oebbUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(oebbPayload)
    });
    const data = await res.json();

    const jnyL = data?.svcResL?.[0]?.res?.jnyL || [];
    const common = data?.svcResL?.[0]?.res?.common || {};
    const prodL = common?.prodL || [];

    const unified = [];

    for (const j of jnyL) {
      const nextStop = j.stopL[2] || null;
      const lat = j.pos?.y / 1e6;
      const lon = j.pos?.x / 1e6;

      const prod = prodL[j.prodX];
      const nr = (prod?.name).match(/\d+/)?.[0] || "";
      const cat = prod?.prodCtx?.catOutL || "";

      if (!cat.toLowerCase().includes("railjet")) continue; // only Railjets

      const scheduledSec = hhmmssToSeconds(nextStop?.aTimeS);
      const actualSec = hhmmssToSeconds(nextStop?.aTimeR);
      const arrivalDelay = scheduledSec != null && actualSec != null
        ? actualSec - scheduledSec
        : null;

      const trainObj = {
        vehicleId: "railjet",
        lat,
        lon,
        heading: null,
        speed: null,
        lastUpdated: Math.floor(Date.now() / 1000),
        nextStop: { arrivalDelay },
        tripShortName: nr + " " + cat,
        tripHeadsign: j.dirTxt || null,
        routeShortName: "<span class=\"MNR2007\">&#481;</span>"
      };

      try {
        const scheduler = await fetchMAVTimetable(nr);

        const stoptimes = scheduler.map(stop => {
          const scheduledArrival = secondsSinceMidnight(stop.arrive);
          const actualArrival = secondsSinceMidnight(stop.actualOrEstimatedArrive);
          const arrivalDelay = actualArrival != null && scheduledArrival != null
            ? actualArrival - scheduledArrival
            : null;

          const scheduledDeparture = secondsSinceMidnight(stop.start);
          const actualDeparture = secondsSinceMidnight(stop.actualOrEstimatedStart);
          const departureDelay = actualDeparture != null && scheduledDeparture != null
            ? actualDeparture - scheduledDeparture
            : null;

          return {
            stop: { name: stop.station.name, platformCode: stop.endTrack || null },
            scheduledArrival,
            arrivalDelay,
            scheduledDeparture,
            departureDelay
          };
        });

        trainObj.trip = {
          arrivalStoptime: {
            scheduledArrival: stoptimes[stoptimes.length - 1]?.scheduledArrival || null,
            arrivalDelay: stoptimes[stoptimes.length - 1]?.arrivalDelay || null,
            stop: { name: stoptimes[stoptimes.length - 1]?.stop.name || null }
          },
          alerts: ["Vonatpozíció az ÖBB adatai alapján"],
          tripShortName: trainObj.tripShortName,
          route: { shortName: trainObj.routeShortName },
          stoptimes,
          tripGeometry: { points: "..." } // optional
        };
      } catch (err) {
        console.error("Error fetching timetable for train", nr, err);
      }

      unified.push(trainObj);
    }

    unifiedData = { data: { vehiclePositions: unified } };
    console.log(`✔ Updated ÖBB Railjets (${unified.length} trains)`);
  } catch (err) {
    console.error("❌ Fetch error:", err);
  }
}

// --- Initial fetch + repeat every minute ---
fetchOEBB();
setInterval(fetchOEBB, 60000);

// --- API endpoint ---
app.get("/api/railjets", (req, res) => {
  res.json(unifiedData);
});

app.listen(port, () => {
  console.log(`🚆 Railjet API server running at http://localhost:${port}/api/railjets`);
});
