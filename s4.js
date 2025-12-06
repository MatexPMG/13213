/********************************************************************
 *  MAIN MÁV REALTIME BACKEND + ÖBB RAILJET MERGED DATASET
 *  All trains (MÁV + Railjet) go into latestFull & latestTrains
 ********************************************************************/

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

/***************************************
 *  DATASETS ACCESSIBLE BY THE WEBSITE
 ***************************************/
let latestTrains = [];      // simplified light version
let latestFull = [];        // full version including ÖBB Railjets

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


/******************************************
 *  --- MÁV GRAPHQL FETCH (unchanged) ---
 ******************************************/
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
        alerts { alertDescriptionText }
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


/*****************************************************
 *  UPDATE MÁV DATA (original logic – unchanged)
 *****************************************************/
async function fetchFull() {
  const data = await fetchGraphQL(FULL_QUERY);
  if (!data?.data?.vehiclePositions) return;

  const now = Math.floor(Date.now() / 1000);
  const cutoff = 600; // 10 minutes

  const UNIX24 = (() => {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Budapest" }));
    return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  })();

  // Keep current trains from BOTH MÁV + Railjet
  const trainMap = new Map(latestFull.map(t => [t.trip?.tripShortName, t]));

  /************ PROCESS MÁV VEHICLE POSITIONS ************/
  for (const t of data.data.vehiclePositions) {
    const id = t.trip?.tripShortName;
    if (!id) continue;

    const existing = trainMap.get(id);

    const arrNew = t.trip?.arrivalStoptime;
    const arrivalTimeNew =
      arrNew?.scheduledArrival != null
        ? arrNew.scheduledArrival + (arrNew.arrivalDelay || 0)
        : null;

    if (existing) {
      const arrOld = existing.trip?.arrivalStoptime;
      const arrivalTimeOld =
        arrOld?.scheduledArrival != null
          ? arrOld.scheduledArrival + (arrOld.arrivalDelay || 0)
          : null;

      if (
        arrivalTimeNew != null &&
        arrivalTimeOld != null &&
        arrivalTimeNew < UNIX24 &&
        arrivalTimeOld > UNIX24
      ) {
        continue;
      }

      if (
        t.lastUpdated > existing.lastUpdated ||
        (arrivalTimeNew != null && arrivalTimeOld != null && arrivalTimeNew >= arrivalTimeOld)
      ) {
        trainMap.set(id, t);
      }
    } else {
      trainMap.set(id, t);
    }
  }

  /************ CLEANUP OLD ************/
  for (const [id, train] of trainMap) {
    if (now - train.lastUpdated > cutoff) {
      trainMap.delete(id);
      continue;
    }

    const arr = train.trip?.arrivalStoptime;
    if (arr?.scheduledArrival != null) {
      const arrivalTime = arr.scheduledArrival + (arr.arrivalDelay || 0);

      const UNIX24 = (() => {
        const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Budapest" }));
        return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
      })();

      if (UNIX24 > arrivalTime + 60 && now - train.lastUpdated > 60) {
        trainMap.delete(id);
      }
    }
  }

  /************ SAVE UPDATED DATA ************/
  latestFull = Array.from(trainMap.values());

  latestTrains = latestFull.map(t => ({
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

  fs.writeFile(path.join(publicDir, "timetables.json"),
    JSON.stringify({ data: { vehiclePositions: latestFull } }),
    () => {}
  );

  fs.writeFile(path.join(publicDir, "trains.json"),
    JSON.stringify({ data: latestTrains }),
    () => {}
  );

  console.log(`MÁV frissítve, összes vonat: ${latestFull.length}`);
}

  app.post('/api/timetables', (req, res) => {
    const { tripShortName } = req.body;
  if (!tripShortName) return res.status(400).json({ error: "Missing tripShortName" });

  const train = latestFull.find(t => t.trip?.tripShortName === tripShortName);
  if (!train) return res.status(404).json({ error: "Train not found" });

  res.json(train);
  });

fetchFull();
setInterval(fetchFull, 15000);



/*****************************************************
 *      --- ÖBB RAILJET FETCHER (INTEGRATED) ---
 *****************************************************/
const oebbURL = "https://fahrplan.oebb.at/gate";
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
          llCrd: { x: 17104947.5, y: 47407892.0 },
          urCrd: { x: 19135605.4, y: 47948232.3 }
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

function hhmmssToSeconds(hms) {
  if (!hms) return null;
  const h = parseInt(hms.slice(0, 2));
  const m = parseInt(hms.slice(2, 4));
  const s = parseInt(hms.slice(4, 6));
  return h * 3600 + m * 60 + s;
}

async function fetchOEBBRailjets() {
  try {
    const res = await fetch(oebbURL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(oebbPayload)
    });

    const data = await res.json();

    const jnyL = data?.svcResL?.[0]?.res?.jnyL || [];
    const prodL = data?.svcResL?.[0]?.res?.common?.prodL || [];

    const railjets = [];

    for (const j of jnyL) {
      const prod = prodL[j.prodX];
      const cat = prod?.prodCtx?.catOutL || "";
      if (cat !== "railjet xpress") continue;

      const nextStop = j.stopL[2] || null;
      const nr = (prod.name.match(/\d+/) || [""])[0];

      const scheduled = hhmmssToSeconds(nextStop?.aTimeS);
      const actual = hhmmssToSeconds(nextStop?.aTimeR);

      const RJ = {
        vehicleId: "oebb_railjet",
        lat: j.pos?.y / 1e6,
        lon: j.pos?.x / 1e6,
        heading: null,
        speed: null,
        lastUpdated: Math.floor(Date.now() / 1000),
        nextStop: { arrivalDelay: actual != null && scheduled != null ? actual - scheduled : null },
        tripShortName: `${nr} railjet xpress`,
        tripHeadsign: j.dirTxt || "",
        routeShortName: "RJX",
        trip: {
          arrivalStoptime: {
            scheduledArrival: scheduled,
            arrivalDelay: actual - scheduled,
            stop: { name: nextStop?.name || "" }
          },
          alerts: ["Position from ÖBB"],
          tripShortName: `${nr} railjet xpress`,
          route: { shortName: "RJX" },
          stoptimes: [],
          tripGeometry: { points: "" }
        }
      };

      railjets.push(RJ);
    }

    /******** MERGE RAILJETS INTO THE DATASET ********/
    const map = new Map(latestFull.map(t => [t.trip?.tripShortName, t]));

    for (const rj of railjets) {
      map.set(rj.tripShortName, rj);
    }

    latestFull = Array.from(map.values());
    latestTrains = latestFull.map(t => ({
      vehicleId: t.vehicleId || "",
      lat: t.lat,
      lon: t.lon,
      heading: t.heading,
      speed: t.speed,
      lastUpdated: t.lastUpdated,
      nextStop: t.nextStop,
      tripShortName: t.trip?.tripShortName,
      tripHeadsign: t.trip?.arrivalStoptime?.stop?.name || "",
      routeShortName: t.trip?.route?.shortName || ""
    }));

    console.log("ÖBB Railjets updated:", railjets.length);

  } catch (err) {
    console.error("ÖBB fetch failed:", err.message);
  }
}

// Run ÖBB every 60 seconds
fetchOEBBRailjets();
setInterval(fetchOEBBRailjets, 60000);


/******************************************
 *          START SERVER
 ******************************************/
app.listen(port, "0.0.0.0", () => {
  console.log(`🚉 Backend listening on port ${port}`);
});
