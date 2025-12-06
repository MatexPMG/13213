let map;
let sel = null;
let tLayer;

let selID = null;
const tMarkers = new Map();
const srchIn = document.getElementById('trainSearch');
const sugBox = document.getElementById('suggestions');

function init() {
    map = L.map('map', {
        center: [47.18, 19.5],
        zoom: 8,
        minZoom: 6,
        maxZoom: 17,
        fadeAnimation: false,
        maxBounds: [
            [42.18, 4.5],
            [52.18, 34.5]
        ],
        maxBoundsViscosity: 0.5
    });

    map.zoomControl.setPosition('bottomright');

    const attr = ' CC-BY-SA <a href="https://openrailwaymap.org/">OpenRailwayMap</a>';

    const ormStandard = L.tileLayer('https://{s}.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png', { attribution: attr });
    const ormSignals = L.tileLayer('https://{s}.tiles.openrailwaymap.org/signals/{z}/{x}/{y}.png', { attribution: attr });
    const ormElectrification = L.tileLayer('https://{s}.tiles.openrailwaymap.org/electrification/{z}/{x}/{y}.png', { attribution: attr });
    const ormGauge = L.tileLayer('https://{s}.tiles.openrailwaymap.org/gauge/{z}/{x}/{y}.png', { attribution: attr });
    const ormMaxspeed = L.tileLayer('https://{s}.tiles.openrailwaymap.org/maxspeed/{z}/{x}/{y}.png', { attribution: attr });

    const OSM = L.tileLayer.grayscale('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: 'Térképadatok © <a href="https://openstreetmap.org/">OpenStreetMap</a> szerkesztők'
    });

    const ormLayers = {
      "Vágányzat": ormStandard,
      "Sebességkorlátok": ormMaxspeed,
      "Villamosítás": ormElectrification,
      "Vonatbefolyásolás": ormSignals,
      "Nyomtáv": ormGauge,
    };

    tLayer = L.layerGroup().addTo(map);

    L.control.layers(ormLayers).addTo(map);
    OSM.addTo(map);

    ormStandard.addTo(map);

    L.control.scale({'metric':true,'imperial':false}).addTo(map);

    L.control.locate({
      position: 'bottomright',
      showPopup: false,
      locateOptions: {
        maxZoom: 13
      }
    }).addTo(map);    
}

init();

let tDMap = new Map();
let click = false;

function markers() {
  fetch('https://13213-production.up.railway.app/api/trains')
    .then(res => res.json())
    .then(json => {    
      tLayer.clearLayers();
      tMarkers.clear();

      const trains = json.data || [];

      trains.forEach(train => {
        const ID = train.vehicleId ?? "";
        const name = train.tripShortName ?? "";
        tDMap.set(name, train);

        const delay = Math.round((train.nextStop?.arrivalDelay ?? 0) / 60);
        const lat = train.lat;
        const lon = train.lon;
        const heading = train.heading ?? 0;
        const speed = Math.round((train.speed ?? 0) * 3.6);
        const dest = train.tripHeadsign ?? "";
        const icon = train.routeShortName ?? "";

        const UIC = ID.includes(':') ? ID.split(':')[1] : ID;
        let loc
        if (train.vehicleId === "railjet") {
          loc = "railjet"
        } else {
          loc = UIC ? `${UIC.slice(5, 8)} ${UIC.slice(8, 11)}` : "";
        }
        const searchId = `${name} | ${loc}`;

        const marker = L.marker([lat, lon], {
            trainData: train,
            UIC: loc,
            icon: L.divIcon({
             html: `
              <div class="train-marker">
              <div class="circle" style="background-color: ${delCol(delay)};"></div>
              ${speed > 0 ? `
                <div class="arrow" style="
                transform: translate(-50%, -50%) rotate(${heading}deg) translateY(-13px);
                "></div>` : ""}
              </div>
              `,
             className: "marker",
             iconAnchor: [9, 9],
            }),
        });

        tMarkers.set(searchId, marker);

        marker.on('click', () => {
          selID = name;
          TTupdate(train);
          LocoUpdate(name);

          if (sel) map.removeLayer(sel);
          sel = L.circleMarker([lat, lon], {
            radius: window.innerWidth < 1080 ? 22 * 1.4 : 22,
            color: 'aqua',
            fillColor: 'aqua',
            fillOpacity: 0.75,
            weight: 0
          }).addTo(map);
        });

        const popupContent = `
          <div class="custom-popup">
            <b>${icon} ${name} &rarr;</b> ${dest}
            <i>${delay > 0 ? "+" + delay : delay}</i>
          </div>
        `;
        const popup = L.popup({
          className: 'custom-popup',
          closeButton: false,
          autoPan: false,
          maxWidth: 600
        }).setContent(popupContent);

        marker.on('mouseover', () => marker.bindPopup(popup).openPopup());
        marker.on('mouseout', () => marker.closePopup());

        tLayer.addLayer(marker);

        if (selID === name && sel)
          sel.setLatLng([lat, lon]);
      });

      if (!click) {
        map.on('click', () => {
          if (sel) {
            map.removeLayer(sel);
            sel = null;
          }
          selID = null;

          document.getElementById("train-info").style.display = "none";
          document.getElementById("loco-info").style.display = "none";

          if (trainInfoUpdater) {
            clearTimeout(trainInfoUpdater);
            clearInterval(trainInfoUpdater);
            trainInfoUpdater = null;
          }
          if (locoInfoUpdater) {
            clearTimeout(locoInfoUpdater);
            clearInterval(locoInfoUpdater);
            locoInfoUpdater = null;
          }
          if (window.activeRoute) map.removeLayer(window.activeRoute);
        });
        click = true;
      }
    }
  );
}

function delCol(delay) {
  if (delay <= 5) return 'rgb(59, 233, 42)';
  if (delay <= 19) return 'rgb(251, 255, 0)';
  if (delay <= 59) return 'rgb(255, 165, 0)';
  if (delay >= 60) return 'rgb(255, 0, 17)';
  return 'rgb(59, 233, 42)';
}

markers();
setInterval(markers, 20000);

srchIn.addEventListener('input', () => {
  const query = srchIn.value.trim().toLowerCase();
  sugBox.innerHTML = '';

  if (!query) {
    sugBox.style.display = 'none';
    return;
  }

  const matches = Array.from(tMarkers.keys())
    .filter(name => name.toLowerCase().includes(query))
    .sort((a, b) => {
      const numA = parseInt(a.match(/\d+/)?.[0] || 0);
      const numB = parseInt(b.match(/\d+/)?.[0] || 0);
      return numA - numB;
    });

  if (matches.length === 0) {
    sugBox.style.display = 'none';
    return;
  }

  matches.forEach(match => {
    const div = document.createElement('div');
    const [name, locPart] = match.split('|').map(s => s.trim());
    
    div.innerHTML = `${name} <span class="loc">| ${locPart}</span>`;

    div.onclick = () => {
      srchIn.value = match;
      clickSim(match);
      sugBox.style.display = 'none';
    };

    sugBox.appendChild(div);
  });

  sugBox.style.display = 'block';
});

srchIn.addEventListener('blur', () => {
  setTimeout(() => {
    sugBox.style.display = 'none';
  }, 100);
});

srchIn.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const input = srchIn.value.trim();
    const exact = tMarkers.get(input);
    if (exact) {
      clickSim(input);
    } else {
      const match = Array.from(tMarkers.keys())
        .filter(k => k.toLowerCase().includes(input.toLowerCase()))
        .sort((a, b) => {
          const na = parseInt(a.match(/\d+/)?.[0] || 0);
          const nb = parseInt(b.match(/\d+/)?.[0] || 0);
          return na - nb;
        })[0];
      if (match) clickSim(match);
    }
    sugBox.style.display = 'none';
  }
});

function clickSim(name) {
  const marker = tMarkers.get(name);
  if (marker) {
    marker.fire('click');
    map.flyTo(marker.getLatLng(), 12, {
      duration: 0.1
    })
  }
  srchIn.value = '';
}

function d(encoded) {
  let points = [];
  let index = 0, len = encoded.length;
  let lat = 0, lng = 0;

  while (index < len) {
    let b, shift = 0, result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    let dlat = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lat += dlat;

    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    let dlng = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lng += dlng;

    points.push([lat / 1e5, lng / 1e5]);
  }

  return points;
}

function poly(tripGeometry, map) {
  if (!tripGeometry || !tripGeometry.points) return null;

  const latlngs = d(tripGeometry.points);

  const polyline = L.polyline(latlngs, {
    color: "red",
    weight: 4,
    opacity: 0.8
  }).addTo(map);

  return polyline;
}

let trainInfoUpdater = null;
let savedScrollTop = null;
let firstRenderDone = false;

function TTupdate(train) {

  if (trainInfoUpdater) {
    clearTimeout(trainInfoUpdater);
    clearInterval(trainInfoUpdater);
    trainInfoUpdater = null;
  }

  savedScrollTop = null;
  firstRenderDone = false;

  function fetchAndRender() {
    if (!train?.tripShortName) return;

    fetch('https://13213-production.up.railway.app/api/timetables', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ tripShortName: train.tripShortName })
    })
    .then(res => {
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      return res.json();
    })
    .then(data => {
      showTrainInfo(data);
    })
    .catch(err => {
      console.error('Error fetching timetable:', err);
    });
  }

  fetchAndRender();

  function scheduleNextMinute() {
    const now = new Date();
    const msToNextMinute = (63 - now.getSeconds()) * 1000 - now.getMilliseconds();

    trainInfoUpdater = setTimeout(() => {
      fetchAndRender();
      trainInfoUpdater = setInterval(fetchAndRender, 60 * 1000);
    }, msToNextMinute);
  }

  scheduleNextMinute();
}

function showTrainInfo(train) {
  const container = document.getElementById('train-info');
  container.style.display = 'block';

  const name = train.trip?.tripShortName || 'N/A';
  const icon = train.trip?.route?.shortName || '';

  const dest = train.trip?.arrivalStoptime?.stop.name || 'N/A';
  const delay = Math.round(train.nextStop?.arrivalDelay / 60);
  const delayHTML = delay > 0 ? `<h2>A pillanatnyi késés ${delay} perc</h2>`: '';
  const alert = train.trip.alerts?.[0]?.alertDescriptionText || null;
  const alertHTML = alert ? `<h3>${alert}</h3>` : '';

  const now = new Date();
  const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

  const firstDep = train.trip.stoptimes[0]?.scheduledDeparture ?? 0;
  const lastArr = train.trip.stoptimes.at(-1)?.scheduledArrival ?? 0;
  if (lastArr - firstDep > 12 * 3600 && nowSec < firstDep) {
    nowSec += 86400;
  }

  let lastPassedIndex = 0;

  const rows = train.trip.stoptimes.map((stop, i, arr) => {
    const schedArr = formatTime(stop.scheduledArrival);
    const schedDep = formatTime(stop.scheduledDeparture);
    const realArr = stop.arrivalDelay
      ? formatTime(stop.scheduledArrival + stop.arrivalDelay)
    : schedArr;
    const realDep = stop.departureDelay
      ? formatTime(stop.scheduledDeparture + stop.departureDelay)
    : schedDep;

    let arrClass = "ontime";
    if (stop.arrivalDelay < 0) arrClass = "early";
    else if (stop.arrivalDelay > 0) arrClass = "delayed";

    let depClass = "ontime";
    if (stop.departureDelay < 0) depClass = "early";
    else if (stop.departureDelay > 0) depClass = "delayed";

    const depTimeSec = stop.scheduledDeparture + (stop.departureDelay || 0);
    const rowClass = depTimeSec < nowSec
    ? (i % 2 === 0 ? "past even" : "past odd")
    : (i % 2 === 0 ? "future even" : "future odd");

    if (depTimeSec < nowSec) {
      lastPassedIndex = i;
    }

    const showArr = i > 0;
    const showDep = i < arr.length-1;

    return `
      <tr class="${rowClass}" id="station-row-${i}">
        <td id="stationN" rowspan="2">${stop.stop.name}</td>
          <td id="SchArr">${showArr ? schedArr : ""}</td>
          <td id="SchDep">${showDep ? schedDep : ""}</td>
        <td id="platformN" rowspan="2">${stop.stop.platformCode || '-'}</td>
      </tr>
      <tr class="${rowClass}">
        <td class="real ${arrClass}">${showArr ? realArr : ""}</td>
        <td class="real ${depClass}">${showDep ? realDep : ""}</td>
      </tr>
    `;
  }).join('');

  container.innerHTML = `
  <div class="timetable">
    <h1>
      ${name}
    </h1>
    <h6>
      <span>${icon}</span> → ${dest}
    </h6>
    ${delayHTML}
    ${alertHTML}
    <div class="tbody-container" id="tbody-container">
      <table>
        <thead>
          <tr>
            <th class="all">Állomás</th>
            <th class="erk">Érkezés</th>
            <th class="ind">Indulás</th>
            <th class="vg">Vágány</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  </div>
  `;

  const tbodyContainer = document.getElementById("tbody-container");

  if (savedScrollTop !== null) {
    tbodyContainer.scrollTop = savedScrollTop;
  } else if (!firstRenderDone) {
    const lastRow = document.getElementById(`station-row-${lastPassedIndex}`);
    if (lastRow) {
      lastRow.scrollIntoView({ block: "center"});
    }
    firstRenderDone = true;
  }

  tbodyContainer.onscroll = () => {
    savedScrollTop = tbodyContainer.scrollTop;
  };

  if (window.activeRoute) map.removeLayer(window.activeRoute);
  window.activeRoute = poly(train.trip.tripGeometry, map);
}

function formatTime(seconds) {
  const d = new Date(0);
  d.setSeconds(seconds);
  return d.toISOString().substr(11, 5); 
}

let locoData = {};
let locoInfoUpdater = null;

fetch('locos.json')
  .then(res => res.json())
  .then(data => {
    locoData = data;
  });

function uicC(uic) {
  return uic.toString().substring(5, 8);
}

function locoInfo(train) {
  const panel = document.getElementById('loco-info');
  panel.style.display = 'block';

  const isRailjet = train.vehicleId === "railjet";

  let rawUIC;
  if (isRailjet) {
    rawUIC = "railjet";                     // display in UI
  } else {
    rawUIC = train.vehicleId.split(':')[1] || train.vehicleId;
  }

  const series = isRailjet ? "railjet" : (uicC(rawUIC) || rawUIC);
  const loco = locoData[series] || {};
  function uicF(uic) {
    if (!uic || uic.length < 12) return uic;
    return `${uic.slice(0,2)} ${uic.slice(2,4)} ${uic.slice(4,8)} ${uic.slice(8,11)}-${uic.slice(11)}`;
  }
  const formattedUIC = isRailjet ? "railjet" : uicF(rawUIC);
  const speed = Math.round(train.speed * 3.6) || 'N/A';
  const nick = loco.nick || '-';
  const manufacturer = loco.manufacturer || '-';
  const production = loco.production || '-';
  const vmax = loco.vmax || '-';
  const power = loco.power || '-';

  let imgSrc, FBCKimgSrc;
  if (isRailjet) {
    imgSrc = `img/vehicles/railjet.jpg`;
    FBCKimgSrc = `img/vehicles/railjet.jpg`;
  } else {
    const UIC = train.vehicleId.split(':')[1] || "";
    const locNum = UIC ? `${UIC.slice(5,8)} ${UIC.slice(8,11)}` : rawUIC;
    imgSrc = `img/vehicles/${series}/${locNum}.jpg`;
    FBCKimgSrc = `img/vehicles/${series}.jpg`;
  }

  panel.innerHTML = `
    <h2>Vontatójármű</h2>
    <img src="${imgSrc}" alt="${series}" id="locoIMG"
         onerror="this.onerror=null; this.src='${FBCKimgSrc}';" />
    <p>${formattedUIC}</p>
    <table>
      <tr><td>Sebesség:</td><td id="loco-speed">${speed} km/h</td></tr>
      <tr class="odd"><td>Engedélyezett sebesség:</td><td>${vmax} km/h</td></tr>
      <tr><td>Becenév:</td><td>${nick}</td></tr>
      <tr class="odd"><td>Gyártó:</td><td>${manufacturer}</td></tr>
      <tr><td>Gyártásban:</td><td>${production}</td></tr>
      <tr class="odd"><td>Teljesítmény:</td><td>${power}</td></tr>
    </table>
  `;
}

function updateLocoSpeed(train) {
  const speedElem = document.getElementById('loco-speed');
  if (!speedElem || !train) return;

  const speed = Math.round(train.speed * 3.6) || 'N/A';
  speedElem.textContent = `${speed} km/h`;
}

function LocoUpdate(name) {
  if (locoInfoUpdater) clearInterval(locoInfoUpdater);

  const train = tDMap.get(name);
  if (!train) return;

  locoInfo(train);

  locoInfoUpdater = setInterval(() => {
    const currentTrain = tDMap.get(name);
    if (currentTrain) updateLocoSpeed(currentTrain);
  }, 5000);
}