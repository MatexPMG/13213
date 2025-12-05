const express = require("express");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const compression = require("compression");

const app = express();
const port = process.env.PORT || 3000;

app.use(compression());
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

const publicDir = path.join(__dirname, "public");
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

let latestTrains = [];
let latestFull = [];

app.use(express.static(publicDir, { etag: false, maxAge: 0 }));

// ---------------- API Endpoints ----------------
app.get("/api/timetables", (req, res) => {
  res.json({ data: { vehiclePositions: latestFull } });
});

app.get("/api/trains", (req, res) => {
  res.json({ data: latestTrains });
});

app.get("/", (req, res) => {
  res.send("Udv itt a Vonatinfo backendjen :)");
});

// ---------------- Utility Functions ----------------
function hhmmssToSeconds(hms) {
  if (!hms) return null;
  const h = parseInt(hms.slice(0, 2), 10);
  const m = parseInt(hms.slice(2, 4), 10);
  const s = parseInt(hms.slice(4, 6), 10);
  return h * 3600 + m * 60 + s;
}

function secondsSinceMidnight(isoStr) {
  if (!isoStr) return null;
  const d = new Date(isoStr);
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
}

// ---------------- MAV GraphQL ----------------
const MAV_URL = "https://mavplusz.hu//otp2-backend/otp/routers/default/index/graphql";
const FULL_QUERY = { /* ...your existing MAV GraphQL query... */ };

async function fetchGraphQL(query) {
  try {
    const res = await fetch(MAV_URL, {
      method: "POST",
      headers: { "User-Agent": "Mozilla/5.0", "Content-Type": "application/json" },
      body: JSON.stringify(query)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error("GraphQL request failed:", err.message);
    return null;
  }
}

// ---------------- Fetch MAV Timetable ----------------
async function fetchMAVTimetable(trainNumber) {
  try {
    const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0] + "T23:00:00.000Z";
    const payload = { type: "TrainInfo", travelDate: yesterday, minCount: "0", maxCount: "9999999", trainNumber };
    const res = await fetch("https://jegy-a.mav.hu/IK_API_PROD/api/InformationApi/GetTimetable", {
      method: "POST",
      headers: { "Content-Type": "application/json", usersessionid: "a2" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    return data?.trainSchedulerDetails?.[0]?.scheduler || [];
  } catch (err) {
    console.error("MAV timetable fetch failed for", trainNumber, err);
    return [];
  }
}

// ---------------- ÖBB Railjet ----------------
const OEBB_URL = "https://fahrplan.oebb.at/gate";
const today = new Date().toISOString().split("T")[0].replace(/-/g, "");
const OEBB_PAYLOAD = { /* ...your existing ÖBB payload... */ };

// ---------------- Combined Fetch Functions ----------------
async function fetchMAV() {
  try {
    const data = await fetchGraphQL(FULL_QUERY);
    if (!data?.data?.vehiclePositions) return;

    const now = Math.floor(Date.now() / 1000);
    const cutoff = 600;

    // Keep current trains in a map
    const trainMap = new Map(latestFull.map(t => [t.trip?.tripShortName, t]));

    for (const t of data.data.vehiclePositions) {
      const id = t.trip?.tripShortName;
      if (!id) continue;

      const existing = trainMap.get(id);
      if (!existing || t.lastUpdated > existing.lastUpdated) {
        trainMap.set(id, t);
      }
    }

    // Remove stale trains
    for (const [id, train] of trainMap) {
      if (now - train.lastUpdated > cutoff) trainMap.delete(id);
    }

    latestFull = Array.from(trainMap.values());
    updateTrainsFromFullData();
    
    saveDataToFiles();
    
    console.log(`✔ MAV trains updated: ${data.data.vehiclePositions.length} fetched, ${latestFull.length} active`);
  } catch (err) {
    console.error("MAV fetch error:", err);
  }
}

async function fetchOEBB() {
  try {
    const now = Math.floor(Date.now() / 1000);
    const res = await fetch(OEBB_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(OEBB_PAYLOAD)
    });
    const data = await res.json();

    const jnyL = data?.svcResL?.[0]?.res?.jnyL || [];
    const prodL = data?.svcResL?.[0]?.res?.common?.prodL || [];

    const promises = jnyL.map(async j => {
      const nextStop = j.stopL[2] || null;
      const lat = j.pos?.y / 1e6;
      const lon = j.pos?.x / 1e6;
      const prod = prodL[j.prodX];
      const nr = (prod?.name).match(/\d+/)?.[0] || "";
      const cat = prod?.prodCtx?.catOutL || "";
      if (!cat.toLowerCase().includes("railjet")) return null;

      const scheduledSec = hhmmssToSeconds(nextStop?.aTimeS);
      const actualSec = hhmmssToSeconds(nextStop?.aTimeR);
      const arrivalDelay = scheduledSec != null && actualSec != null ? actualSec - scheduledSec : null;

      const trainObj = {
        vehicleId: "railjet_" + nr,
        lat, lon,
        heading: null,
        speed: null,
        lastUpdated: now,
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
          const arrivalDelay = actualArrival != null && scheduledArrival != null ? actualArrival - scheduledArrival : null;
          const scheduledDeparture = secondsSinceMidnight(stop.start);
          const actualDeparture = secondsSinceMidnight(stop.actualOrEstimatedStart);
          const departureDelay = actualDeparture != null && scheduledDeparture != null ? actualDeparture - scheduledDeparture : null;
          return {
            stop: { name: stop.station.name, platformCode: stop.endTrack || null },
            scheduledArrival, arrivalDelay, scheduledDeparture, departureDelay
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
          tripGeometry: { points: "polyline_placeholder" }
        };
      } catch (err) {
        console.error("MAV timetable fetch failed for", nr, err);
      }

      return trainObj;
    });

    const oebbVehicles = (await Promise.all(promises)).filter(Boolean);

    // Merge with existing trains
    const trainMap = new Map(latestFull.map(t => [t.trip?.tripShortName, t]));
    for (const t of oebbVehicles) {
      if (t.trip?.tripShortName) {
        trainMap.set(t.trip.tripShortName, t);
      }
    }

    latestFull = Array.from(trainMap.values());
    updateTrainsFromFullData();
    
    saveDataToFiles();

    console.log(`✔ ÖBB Railjets added: ${oebbVehicles.length}, Total trains: ${latestFull.length}`);
  } catch (err) {
    console.error("OEBB fetch failed:", err);
  }
}

function updateTrainsFromFullData() {
  latestTrains = latestFull.map(t => ({
    vehicleId: t.vehicleId || "",
    lat: t.lat, lon: t.lon,
    heading: t.heading, speed: t.speed,
    lastUpdated: t.lastUpdated,
    nextStop: t.nextStop ? { arrivalDelay: t.nextStop.arrivalDelay } : null,
    tripShortName: t.trip?.tripShortName,
    tripHeadsign: t.trip?.arrivalStoptime?.stop?.name || "",
    routeShortName: t.trip?.route?.shortName || ""
  }));
}

function saveDataToFiles() {
  fs.writeFileSync(
    path.join(publicDir, "timetables.json"), 
    JSON.stringify({ data: { vehiclePositions: latestFull } })
  );
  fs.writeFileSync(
    path.join(publicDir, "trains.json"), 
    JSON.stringify({ data: latestTrains })
  );
}

// ---------------- Initialize and Run intervals ----------------
async function initialize() {
  console.log("🚉 Starting server...");
  
  // Initial fetches
  await fetchMAV();
  await fetchOEBB();
  
  // Start intervals
  setInterval(fetchMAV, 15000); // every 15s
  setInterval(fetchOEBB, 60000); // every 60s
  
  console.log(`Server ready on port ${port}`);
}

app.listen(port, "0.0.0.0", async () => {
  await initialize();
});