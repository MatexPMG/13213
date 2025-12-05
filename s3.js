const express = require("express");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch"); // node-fetch@2
const compression = require("compression");

const app = express();
const port = process.env.PORT || 3000;

app.use(compression());
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

const publicDir = path.join(__dirname, "public");
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

let latestTrains = [];
let latestFull = [];
let unifiedData = { data: { vehiclePositions: [] } }; // ÖBB Railjets

// ---------------- MAV GraphQL ----------------
const mavUrl = "https://mavplusz.hu//otp2-backend/otp/routers/default/index/graphql";

const FULL_QUERY = {
  query: `
  {
    vehiclePositions(
      swLat: 45.7457,
      swLon: 16.2103,
      neLat: 48.5637,
      neLon: 22.9067,
      modes: [RAIL, TRAMTRAIN]
    ) {
      vehicleId
      lat
      lon
      heading
      speed
      lastUpdated
      nextStop { arrivalDelay }
      trip {
        arrivalStoptime {
          scheduledArrival
          arrivalDelay
          stop { name }
        }
        alerts(types: [ROUTE, TRIP]) { alertDescriptionText }
        tripShortName
        route { shortName }
        stoptimes {
          stop { name platformCode }
          scheduledArrival
          arrivalDelay
          scheduledDeparture
          departureDelay
        }
        tripGeometry { points }
      }
    }
  }`,
  variables: {}
};

async function fetchGraphQL(query) {
  try {
    const res = await fetch(mavUrl, {
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

async function fetchMAV() {
  const data = await fetchGraphQL(FULL_QUERY);
  if (!data?.data?.vehiclePositions) return [];

  const now = Math.floor(Date.now() / 1000);
  const cutoff = 600; // 10 minutes
  const UNIX24 = (() => {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Budapest" }));
    return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  })();

  const trainMap = new Map(latestFull.map(t => [t.trip?.tripShortName, t]));

  for (const t of data.data.vehiclePositions) {
    const id = t.trip?.tripShortName;
    if (!id) continue;
    const existing = trainMap.get(id);

    const arrNew = t.trip?.arrivalStoptime;
    const arrivalTimeNew = arrNew?.scheduledArrival != null ? arrNew.scheduledArrival + (arrNew.arrivalDelay || 0) : null;

    if (existing) {
      const arrOld = existing.trip?.arrivalStoptime;
      const arrivalTimeOld = arrOld?.scheduledArrival != null ? arrOld.scheduledArrival + (arrOld.arrivalDelay || 0) : null;
      if (arrivalTimeNew != null && arrivalTimeOld != null && arrivalTimeNew < UNIX24 && arrivalTimeOld > UNIX24) continue;
      if (t.lastUpdated > existing.lastUpdated || (arrivalTimeNew != null && arrivalTimeOld != null && arrivalTimeNew >= arrivalTimeOld)) {
        trainMap.set(id, t);
      }
    } else {
      trainMap.set(id, t);
    }
  }

  // Cleanup old trains
  for (const [id, train] of trainMap) {
    if (now - train.lastUpdated > cutoff) trainMap.delete(id);
    const arr = train.trip?.arrivalStoptime;
    if (arr?.scheduledArrival != null) {
      const arrivalTime = arr.scheduledArrival + (arr.arrivalDelay || 0);
      if (UNIX24 > arrivalTime + 60 && now - train.lastUpdated > 60) trainMap.delete(id);
    }
  }

  const newFull = Array.from(trainMap.values());
  latestFull = newFull;

  const newLight = newFull.map(t => ({
    vehicleId: t.vehicleId || "",
    lat: t.lat,
    lon: t.lon,
    heading: t.heading,
    speed: t.speed,
    lastUpdated: t.lastUpdated,
    nextStop: t.nextStop ? { arrivalDelay: t.nextStop.arrivalDelay } : null,
    tripShortName: t.trip?.tripShortName,
    tripHeadsign: t.trip?.arrivalStoptime?.stop?.name || "",
    routeShortName: t.trip?.route?.shortName || ""
  }));

  latestTrains = newLight;
  return newFull;
}

// ---------------- ÖBB Railjets ----------------
const oebbUrl = "https://fahrplan.oebb.at/gate";
const today = new Date().toISOString().split("T")[0].replace(/-/g, "");

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

async function fetchMAVTimetable(trainNumber) {
  const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0] + "T23:00:00.000Z";
  const payload = { type: "TrainInfo", travelDate: yesterday, minCount: "0", maxCount: "9999999", trainNumber };
  const res = await fetch("https://jegy-a.mav.hu/IK_API_PROD/api/InformationApi/GetTimetable", {
    method: "POST",
    headers: { "Content-Type": "application/json", usersessionid: "a2" },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  return data?.trainSchedulerDetails?.[0]?.scheduler || [];
}

async function fetchOEBB() {
  try {
    const res = await fetch(oebbUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(oebbPayload) });
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

      if (!cat.toLowerCase().includes("railjet")) continue;

      const scheduledSec = hhmmssToSeconds(nextStop?.aTimeS);
      const actualSec = hhmmssToSeconds(nextStop?.aTimeR);
      const arrivalDelay = scheduledSec != null && actualSec != null ? actualSec - scheduledSec : null;

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
          const arrivalDelay = actualArrival != null && scheduledArrival != null ? actualArrival - scheduledArrival : null;
          const scheduledDeparture = secondsSinceMidnight(stop.start);
          const actualDeparture = secondsSinceMidnight(stop.actualOrEstimatedStart);
          const departureDelay = actualDeparture != null && scheduledDeparture != null ? actualDeparture - scheduledDeparture : null;
          return { stop: { name: stop.station.name, platformCode: stop.endTrack || null }, scheduledArrival, arrivalDelay, scheduledDeparture, departureDelay };
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
          tripGeometry: { points: "..." }
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

// ---------------- Combined fetch ----------------
async function fetchAll() {
  const mavTrains = await fetchMAV();
  await fetchOEBB();
  const combined = [...mavTrains, ...unifiedData.data.vehiclePositions];
  fs.writeFile(path.join(publicDir, "timetables.json"), JSON.stringify({ data: { vehiclePositions: combined } }), () => {});
  console.log(`Total trains saved: ${combined.length}`);
}

// ---------------- API Endpoints ----------------
app.use(express.static(publicDir, { etag: false, maxAge: 0 }));

app.get("/api/timetables", (req, res) => {
  const combined = [...latestFull, ...unifiedData.data.vehiclePositions];
  res.json({ data: { vehiclePositions: combined } });
});

app.get("/api/trains", (req, res) => {
  res.json({ data: latestTrains });
});

app.get("/", (req, res) => {
  res.send("Udv itt a Vonatinfo backendjen :)");
});

app.post("/api/timetables", (req, res) => {
  const { tripShortName } = req.body;
  if (!tripShortName) return res.status(400).json({ error: "Missing tripShortName" });
  const train = [...latestFull, ...unifiedData.data.vehiclePositions].find(t => t.trip?.tripShortName === tripShortName);
  if (!train) return res.status(404).json({ error: "Train not found" });
  res.json(train);
});

// ---------------- Schedule fetching ----------------
fetchAll();
setInterval(fetchAll, 60000); // fetch every 1 minute

app.listen(port, "0.0.0.0", () => {
  console.log(`🚉 Combined server running on port ${port}`);
});
