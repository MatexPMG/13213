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

app.get("/api/timetables", (req, res) => {
  res.json({ data: { vehiclePositions: latestFull } });
});

app.get("/api/trains", (req, res) => {
  res.json({ data: latestTrains });
});

app.get("/", (req, res) => {
  res.send("Udv itt a Vonatinfo backendjen :)");
});

const url = "https://mavplusz.hu//otp2-backend/otp/routers/default/index/graphql";

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
    const res = await fetch(url, {
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

async function fetchFull() {
  const data = await fetchGraphQL(FULL_QUERY);
  if (!data?.data?.vehiclePositions) return;
  const oebbTrains = await fetchOEBB();   // unified array


  const now = Math.floor(Date.now() / 1000);
  const cutoff = 600; // 10 minutes
  const UNIX24 = (() => {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Budapest" }));
    return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  })();

  // Keep current trains in a map
  const trainMap = new Map(latestFull.map(t => [t.trip?.tripShortName, t]));
 for (const t of oebbTrains) {
  const id = t.tripShortName;
  if (!id) continue;
  trainMap.set(id, t); // overwrite MAV version if duplicate
 }

  // ---- Process new incoming vehicles ----
  for (const t of data.data.vehiclePositions) {
    const id = t.trip?.tripShortName;
    if (!id) continue;

    const existing = trainMap.get(id);

    // Compute new train's arrival time (seconds since midnight CET)
    const arrNew = t.trip?.arrivalStoptime;
    const arrivalTimeNew =
      arrNew?.scheduledArrival != null
        ? arrNew.scheduledArrival + (arrNew.arrivalDelay || 0)
        : null;

    if (existing) {
      // Compute old train's arrival time
      const arrOld = existing.trip?.arrivalStoptime;
      const arrivalTimeOld =
        arrOld?.scheduledArrival != null
          ? arrOld.scheduledArrival + (arrOld.arrivalDelay || 0)
          : null;

      // If the new data refers to an already-arrived train, but the old one hasn't arrived yet → ignore update
      if (
        arrivalTimeNew != null &&
        arrivalTimeOld != null &&
        arrivalTimeNew < UNIX24 &&
        arrivalTimeOld > UNIX24
      ) {
        continue; // ignore old/messed-up update
      }

      // Otherwise, update only if newer lastUpdated or later arrival time
      if (
        t.lastUpdated > existing.lastUpdated ||
        (arrivalTimeNew != null && arrivalTimeOld != null && arrivalTimeNew >= arrivalTimeOld)
      ) {
        trainMap.set(id, t);
      }
    } else {
      // New train — add to map
      trainMap.set(id, t);
    }
  }

  // ---- Cleanup: remove old or finished trains ----
  for (const [id, train] of trainMap) {
    // Remove stale trains
    if (now - train.lastUpdated > cutoff) {
      trainMap.delete(id);
      continue;
    }

    // Remove trains whose final arrival time has already passed
  const arr = train.trip?.arrivalStoptime;
  if (arr?.scheduledArrival != null) {
    const arrivalTime = arr.scheduledArrival + (arr.arrivalDelay || 0);

    // Get current time in seconds since midnight (Europe/Budapest)
    const UNIX24 = (() => {
      const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Budapest" }));
      return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    })();

    // Only delete if train arrived more than 2 minutes ago
    // AND hasn't been updated in the last 2 minutes
    if (UNIX24 > arrivalTime + 60 && now - train.lastUpdated > 60) {
      trainMap.delete(id);
    }
    }
  }

  // ---- Save updated train data ----
  const newFull = Array.from(trainMap.values());
  latestFull = newFull;

  const newLight = newFull.map(t => ({    vehicleId: t.vehicleId || "",
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

  fs.writeFile(path.join(publicDir, "timetables.json"), JSON.stringify({ data: { vehiclePositions: latestFull } }), () => {});
  fs.writeFile(path.join(publicDir, "trains.json"), JSON.stringify({ data: newLight }), () => {});

  console.log(`Vonatok száma: ${(latestFull.length)-1} ✅`);

  app.post('/api/timetables', (req, res) => {
    const { tripShortName } = req.body;
  if (!tripShortName) return res.status(400).json({ error: "Missing tripShortName" });

  const train = latestFull.find(t => t.trip?.tripShortName === tripShortName);
  if (!train) return res.status(404).json({ error: "Train not found" });

  res.json(train);
  });
}


// oebb resz
const hafas = "https://fahrplan.oebb.at/gate"; // ÖBB mgate endpoint
const today = new Date().toISOString().split("T")[0].replace(/-/g, "");

const payload = {
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

// ---- Fetch MAV timetable for a train number ----
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

function secondsSinceMidnight(isoStr) {
  if (!isoStr) return null;
  const d = new Date(isoStr);
  return (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds())+3600;
}

function hhmmssToSeconds(hms) {
  if (!hms) return null;
  const h = parseInt(hms.slice(0, 2), 10);
  const m = parseInt(hms.slice(2, 4), 10);
  const s = parseInt(hms.slice(4, 6), 10);
  return h * 3600 + m * 60 + s;
}

// ---- Main function ----
async function fetchOEBB() {
  try {
    const res = await fetch(hafas, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    fs.writeFileSync("raw_oebb.json", JSON.stringify(data, null, 2));

    const jnyL = data?.svcResL?.[0]?.res?.jnyL || [];
    const common = data?.svcResL?.[0]?.res?.common || {};
    const prodL = common?.prodL || [];

    const unified = [];

    for (const j of jnyL) {
      const nextStop = j.stopL[2] || null;
      const lat = j.pos?.y / 1e6;
      const lon = j.pos?.x / 1e6;

      const prod = prodL[j.prodX];
      const nr = (prod?.name).match(/\d+/)[0] || "";
      const cat = prod?.prodCtx?.catOutL || "";

      if (cat !== "railjet xpress") continue; // only Railjets

      const scheduledSec = hhmmssToSeconds(nextStop.aTimeS); // scheduled
 const actualSec = hhmmssToSeconds(nextStop.aTimeR);    // actual
 const arrivalDelay = scheduledSec != null && actualSec != null
  ? actualSec - scheduledSec
  : null;


      const trainObj = {
        vehicleId: "railjet",
        lat,
        lon,
        heading: null,
        speed: null, // ÖBB does not provide speed
        lastUpdated: Math.floor(Date.now() / 1000),
        nextStop: {arrivalDelay: arrivalDelay},
        tripShortName: nr + " " + cat,
        tripHeadsign: j.dirTxt || null,
        routeShortName: "<span class=\"MNR2007\">&#481;</span>"
      };

      // ---- Enrich with MAV timetable ----
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
          alerts: ["Vonatpozíció az ÖBB adatai alapján"], // optional, fill if available
          tripShortName: trainObj.tripShortName,
          route: { shortName: trainObj.routeShortName },
          stoptimes,
          tripGeometry: { points: ""},
        };
      } catch (err) {
        console.error("Error fetching timetable for train", nr, err);
      }

      unified.push(trainObj);
    }
    return unified;
  } catch (err) {
    console.error("❌ Fetch error:", err);
  }
}

fetchFull();
setInterval(fetchFull, 15000);

app.listen(port, "0.0.0.0", () => {
  console.log(`🚉 server OK`);
});