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

function getDates() {
  const now = new Date();

  // YYYYMMDD for ÖBB
  const today = now.toISOString().split("T")[0].replace(/-/g, "");

  // Yesterday 23:00:00.000Z for MÁV
  const yesterday = new Date(now - 86400000)
    .toISOString()
    .split("T")[0] + "T23:00:00.000Z";

  return { today, yesterday };
}

const hafas = "https://fahrplan.oebb.at/gate";

function buildOEBBPayload() {
  const { today } = getDates();

  return {
    id: "v34xpssuk4asggwg",
    ver: "1.88",
    lang: "eng",
    auth: { type: "AID", aid: "5vHavmuWPWIfetEe" },
    client: {
      id: "OEBB",
      type: "WEB",
      name: "webapp",
      l: "vs_webapp",
      v: 21804
    },
    formatted: false,
    ext: "OEBB.14",
    svcReqL: [
      {
        meth: "JourneyGeoPos",
        req: {
          rect: {
            llCrd: { x: 17104947.509765629, y: 47407892.06010505 },
            urCrd: { x: 19135605.46875, y: 47948232.33587184 }
          },
          perSize: 35000,
          perStep: 5000,
          onlyRT: true,
          jnyFltrL: [{ type: "PROD", mode: "INC", value: "4101" }],
          date: today  // ← NOW UPDATES DAILY
        },
        id: "1|3|"
      }
    ]
  };
}


async function fetchMAVTimetable(trainNumber) {
  const { yesterday } = getDates();
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

const lastPositions = {};  // { tripShortName: { lat, lon } }

// heading formula
function calculateHeading(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;

  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const λ1 = toRad(lon1);
  const λ2 = toRad(lon2);

  const y = Math.sin(λ2 - λ1) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(λ2 - λ1);

  let brng = toDeg(Math.atan2(y, x));
  return (brng + 360) % 360;
}

async function fetchOEBB() {
  const payload = buildOEBBPayload();
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
  const lat = j.pos?.y / 1e6;
  const lon = j.pos?.x / 1e6;

  const prod = prodL[j.prodX];
  const nr = (prod?.name).match(/\d+/)[0] || "";
  const cat = prod?.prodCtx?.catOutL || "";

  if (cat !== "railjet xpress") continue; // only Railjets

  const tripShortName = nr + " " + cat;

  let heading = null;
  let speed = 1;
  if (lastPositions[tripShortName]) {
    const prev = lastPositions[tripShortName];

    if (prev.lat !== lat || prev.lon !== lon) {
      heading = Math.round(calculateHeading(prev.lat, prev.lon, lat, lon));
    }
  }

  lastPositions[tripShortName] = { lat, lon };

  if (heading === null) {
    speed = 0;
  }

  const trainObj = {
    vehicleId: "railjet",
    lat,
    lon,
    heading,
    speed, //heading miatt
    lastUpdated: Math.floor(Date.now() / 1000),
    nextStop: { arrivalDelay: null, stopName: null },
    tripShortName: nr + " " + cat,
    tripHeadsign: j.dirTxt || null,
    routeShortName: "<span class=\"MNR2007\">&#481;</span>",
    trip: { stoptimes: [], tripGeometry: { points: "" } }
  };

  // ---- Enrich with MÁV timetable ----
  try {
    const scheduler = await fetchMAVTimetable(nr);

    const nowSec = (() => {
      const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Budapest" }));
      return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    })();

    let nextStopFound = false;

    const stoptimes = scheduler.map(stop => {
      const scheduledArrival = secondsSinceMidnight(stop.arrive);
      const actualArrival = secondsSinceMidnight(stop.actualOrEstimatedArrive);
      const arrivalDelay = actualArrival != null && scheduledArrival != null
        ? actualArrival - scheduledArrival
        : null;

      const scheduledDeparture = secondsSinceMidnight(stop.start) || scheduledArrival;
      const actualDeparture = secondsSinceMidnight(stop.actualOrEstimatedStart);
      const departureDelay = actualDeparture != null && scheduledDeparture != null
        ? actualDeparture - scheduledDeparture
        : null;

      // Set next upcoming stop (only first one in the future)
      if (!nextStopFound && actualArrival != null && actualArrival >= nowSec) {
        trainObj.nextStop = {
          arrivalDelay: arrivalDelay,
          stopName: stop.station.name
        };
        nextStopFound = true;
      }

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
          alerts: [ { alertDescriptionText: "Vonatpozíció az ÖBB adatai alapján" }], // optional, fill if available
          tripShortName: trainObj.tripShortName,
          route: { shortName: trainObj.routeShortName },
          stoptimes,
          tripGeometry: { points: "qabeHc}}bBn@iINyARoAZcBNm@XgAVs@bFgNZs@Xg@Xg@Zc@l@s@hAiAj@g@l@g@zFeEr@m@lAkAt@y@v@cAlAeBvA{Bb@u@f@aAh@mA^_AXy@lCkITs@d@iA\\w@|@gBvLqT`A_BjJoO|IgOjH}KfBeCnA_BfC{C~@mAhCiDbBuB|cAunAjBwBj@o@l@i@t@k@VQj@[bAe@t@UfAU~@Of@E~CWpAMz@O~@Wj@Qb@St@_@nAq@tTkMvDyBpA_A\\Yv@s@|@eA^i@t@sAZo@f@kA~@iCbBcF`@eATk@t@yAp@mAn@aAjA}An@s@h@i@l@i@f@c@rAaAn@a@`Ak@vIeF`HwD`CuAvDyB`C{ApFcDn@]pEiCvA{@lAy@t@g@fDcCnA{@~AaAjIyE`Ai@dCmAvAm@vAi@fA_@tDiAbCo@jCm@nAWvAWdAO~B[xCWzBMpBI|@C~@AzBApCB`BFfCPvI|@xANlBZl@JlR~DnL`CzPtDbj@jL`BZnB\\~BZdALtBPpBH~CDbBAlBGfBKxAMpBUnB]tAWpA[nA[nBo@v@WfBs@vCqApAi@zBaApFkCbf@mUbB{@`B_An@a@~AeAl@c@|AmAn@e@xAsA`Y}W|pCigCrCiCxMwL~A}ArDuDjDwDpA}At@_ApAcB|@sA|@wA|@wAx@{Ax@}Av@_Bt@_Bt@cBp@eBp@gBdA}Cj@kB~@cDx@gDv@iD`@oBl@iD\\qBr@}EhAcINiAT{BHu@~BqPn]ygCR}Ad@wD^}DN}AZyDTeEFuALiDDuADyD|FadH@kAH{B@{@tAy_BnDajEXac@z@kdAh@mm@j@og@~A{mBpB_|Bx@o|@pB{|BHuKfAqnAFiEtAsw@TuLv@_XDyC@aB?cIBwDHiDvEw~ApAqd@^uLTaGv@kRTqENmCr@mK`@eGhH}oAXoDXuCVuBZwBf@wCh@qCXoAt@}Cd@eB~@{Cb@sAd@qAlA}CnAqCf@cAf@}@tAcCn@cAp@cAbB}Bdr@e}@rCuDp@_AxAyBr@iA|AqCl@gAvBsE~@{Bf@mAz@_Cd@sAp@sBdAkD|y@orCvAcFf@iB|@uD`@sB\\kBt@_Fj@mEZwCVkCLkBXeEHqBRqGFkDBoGGgG_@sVi@}XcNwwICoDAmDDaEByABeBNaEP{DV{DZ_EN_B^iDb@eDT}Ap@wDr@oDz@mD|@gDr@_C`h@wcBdD_LhD}LtAiF|@sDp@uChAgFp@mDl@cDp@yD`AsG|@qGr@cG~SinBnMklAzMwmAhGkk@bAcJXcCh@sDd@_Dj@kDj@{Cp@iDp@}Cn@oCt@yCz@cDz@sC~@{C|@qCfAyClo@}dB|@cCnA_DdEgL`lAgaDlqBmoFlA{Cls@gdBv@mBvJsUnBwE`DwHvWqn@dgBghErAyC|Qcd@n`Am}Bd{B{lF~CwHdDyHhDmHzMeTrGiKv@qAzC}EfJmO~GaLzGqK|^sl@xHiMhGoLro@ksAtbCqbF`AeBnOu[jByD`Pm\\`eBioDheCafFj[mp@jw@}_B`GcMtBsElJuSpHgPhnBadEbD}GlDeHbD{G~\\ct@j_@ex@|DuItIkRrFqLhcBcpDdTkd@zh@}hAlKyT|Oc]dB_EzBoFnCsHlByFfB_GvAaFrB_IzAwGbBgIvA_In@yDj@wDd@mDf@}Dj@}E|@cJZoD\\yEXeETcERiEJyCTwGNcIFqF@iE@yDAwEA_DIgGQcIQyFQeEScEWcEYeE[_Es@eI_@eD}@{Ha@yCyAqJuBiL}A{Hy@oDy@mDk[soAmBwHaBqGS_AuDsOI]gCcKmAmEcA}Dq@sCk@iCMw@{BeQ]_CQ_BSyBIqAEyAAsA?{BvAmvARgWbAocAbCckCBuFAaHCsHEwFOoLMoFWsIg@{Mi@}Jc@gHwMskBoC{a@s@uL{@uMgBaW}AeUkAoOYmEcAeMcFwq@maAinNk@yHsJsuAiCka@yFwy@mDee@gQqgC_Dwc@qAaWaJ{dDsI}eDmFsoBgAwa@kB}`@w@aWgBan@gBir@W_KYeH}@oVSkJ[}KiAgSmDcXwGw[gfAgpDsx@goCu]ukA_CgI}ByHk@_BsA}CqBmESk@So@a@cBSiAIi@SwBGoACeBBcHf@}^D_CHuBj@uLp@yMn@kObCgh@RkD\\_FxAcQ`AkKdCgV~A_O`@sCTqA`AmF^oB~Z{yAlXaqAr@qD\\{Bf@_ENwBPeCHmBJeDV_SN_GDiBR_EtQwvC|Bc`@tAoTz@qMlFup@PmCLmCRaGP_GdDayAReHDgANoCd@_H`@uEf@iEP{ATyAr@wDt@wDvBsJvHy\\ZyAfDaOvAoFz@sCr@wBj@_BbDqI^u@bEkJ|FqM`FwKpSub@lCoFnEgJzNeZfDcGPWlDsEtCeDlAoAtAmAdz@cl@hSwNb\\sTrB}A|CuC`g@oh@rq@gs@~CyCnAiAp@k@xFiEpEkCbE{BjE_BrCcAhA_@~FsAnRgEpF}A|B}@~BcAtFsCpFcD`BoA~AoA`ByAx@w@|FgGdBoBn@y@r@iAp@qAh@kAb@gAz@mCTcAXuAVyAN{Ad@wFPsDZmFVwCR}AVyAP_AT_AX{@j@yAp@wAb@y@Zg@V]t@w@t@s@bBoAzAo@bJmCdC{@fh@yPdGmBjKmEvGqF~CgDxCuDzWka@tMqSl[qg@vG_KrBcCbAsAfByBjByBhAkAfBgBxM_LrGyDpHcE`RcKjLqGpEeChG}CtBiAdEkBpCs@xDw@jG_A`BMxAKxAArA?x@FhDVjHr@dABpA?z@Az@EtBSrB]nBg@rAa@fAg@`H}DfEiCbJyFfAw@xAmA\\[bFgFhEiE@C`DaDbA_AbA}@hAw@fAs@nAq@rFeCnEmBtBaAn@SdA_@fA]|@Q`CWz@GbP_@x@GjC]nAWpBo@hCiAnAq@f@]bBmApBiBnAsAhAuAx@kAjBaDpAmCpLsZdAyCx@kCt@qC~BuL`FyYn@mEh@uGHoAF}CFqJCuVGk\\?cUByBZsIf@oIf@uGbB{RZkDj@oEPqAj@aDj@yCVgAjBuHn@oBb@qAr@oBz@sBzBuElCeFnGaLvAsC|AqDjFyNdDkJjLg\\lHyRnJsWlSkk@zAuDlB{D~CiGnCkEfDsExBqC~BaCjGkFnCoBfDoBfGwC`DgA`D_A`HsApQuBdJiAlF{@dEcAlDgAvBy@jKcFl@_@x@]hDwAjRwI~G}CvFkCzIyDbAg@tRyIrLiI~|@e|@nIuMdDaGdD_FbEsEnEkDn]qV`KiQ`F_MRo@rBgIx@qDt@oEl@kEbBsO|AiO\\yEZyEReEJmFBcGEeGOiGQgGU}FY}Fg@yGMaBgAcKe@_E_@_Es@_MSeFI}EGkIMy]Kyg@q@mdBu@i}A?cABcBd@sZf@sVLgE|Aw`@T}ITsN^uRBkD?kBCsCKeCq@qPqAcPQqB[}B]wBk@aDeDmOkA_GgCwLoD}OwAuGsCcNwAiH{@uEgAkH{AcMu@{Hg@iHe@mJYmIcCsw@cAw[i@kPsA_d@cAq\\e@cPwA{f@{@yWk@iRg@sQO}IGkKE}J@_FFwG\\yV`@wa@T_SXePXuTjBmcBDeBLeEHcBH{ANeBZiCR_Bd@mC\\cB~@sDd@cBXy@bJ{T|GiOr@eB|LiYrCgHxByGnC{Kd@gC^aCZ{B\\cDZ_DPqCTmDJaCFuBDwC?}BCuDQgH]{Ge@sFYuCa@}CaBcJsAoFuIkZePqk@aBcJiAqJiA{QMeK@mHl@kPbBwVzA}JzBqIlCyGpGwJnHmIny@_~@|AkB|@iAz@mAbBoCpCeHrBsHnAmGr@oFtLqgA`@iDf@mD`@aCf@_Ch@}Bj@yBl@kBn@iBr@iBt@gBnAcCtAcCp]ak@dA_BjA_B`AkAnAuArAkAbAw@fAu@vA{@tBcA`a@wQzAu@xA{@p@c@lB}AjBkBd@i@|AyBvAaCx@cBtAeDr@wBz@_Dp@_DZaBTcBXiCTgCLoCJqE@uBAuBGaBKoCO}B]oDc@_D[eB_@cB_@aB_CiJm@oCe@qC_@mCWsCSsCEmAE_BE_F?ypAAsGCkCIkCKaCOcCmFws@SaDSiDIeCEeC@gGhEkmAR{D^mF~BuZ\\eEVeCZsBbG}]^cCZgCDm@J{AH{AFmCt@co@p@qz@d@ka@ByDAwBCkBMsDKgBQqBSsB[}Co[ytCa@kDOoAWoAKi@YiAK]Wq@k@oA_@q@W_@[c@SYk@k@UUy@m@YO_@S]O[Kw@QUEg@I]Cg@Aq@@ye@`BuCFi@?yAEgCQkAKka@gDYEk@Kg@Oi@Ua@UUQa@]a@a@MOe@s@Wc@]u@]_ASy@Qy@OeAQsB{Csj@GgBCsB@cBHeCTuDZsCjWkbCPoBJsAFwAHaCFuDXg[b@{h@HgOd@mj@?mAAmAqAwp@KiCQ_D}@yK[}Ca@yCqN}z@{@uGQkAScAa@qBmEuScAyDkA{DaAoCWq@e@gAs@yAeBcDo@aAiByB_CcCs@s@yDmDoBcBc@[cAq@m@]kDwAgB_@aCa@cJ}@cJy@}@A}@BUB{@Py@\\o@\\WPYZ}@dAY^c@t@O`@Qb@o@pCe@`CUtAWzBKnAGfAClA?nA?h@DjAHlA\\hFH~ABjA@dAAjAIfCG`AOrAYdB[xAu@nCo@jBa@dAO`@u@|Ae@x@[h@mAbB_AbAo@v@k@f@eBhAyBlAkIhEoMtG_@RwB`Bg@ZwCxAu@`@{@h@WRu@n@o@t@UZo@`ASb@Yp@Yz@Qn@I^SlAMlAInAC|@?~c@Cp\\"},
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