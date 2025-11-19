// ==================================================================
// 1. CONFIGURATION & GLOBALS
// ==================================================================
// Airports to monitor (ICAO Codes)
const STATION_LIST = "KJFK,EGLL,KORD,KMCO,KSEA,KATL,KLAX,EGKK,EDDF,RJTT,OMDB,KDEN,KDFW,KSFO";

// Proxy to bypass CORS for NOAA data
const PROXY_URL = "https://api.allorigins.win/raw?url=";

// NOAA API URLs
const BASE_METAR = `https://aviationweather.gov/api/data/metar?ids=${STATION_LIST}&format=json`;
const BASE_TAF = `https://aviationweather.gov/api/data/taf?ids=${STATION_LIST}&format=json`;
const METAR_URL = PROXY_URL + encodeURIComponent(BASE_METAR);
const TAF_URL = PROXY_URL + encodeURIComponent(BASE_TAF);

// RainViewer API (for Radar)
const RAINVIEWER_API = 'https://api.rainviewer.com/public/weather-maps.json';

// Global State
let aviationData = [];
let radarFrames = [];     // Array of timestamps for radar
let radarLayers = {};     // Cache for radar tile layers
let currentFrameIndex = 0;
let isPlaying = false;
let animationTimer = null;
let radarVisible = false;


// ==================================================================
// 2. CLOCK BAR LOGIC
// ==================================================================
// Define available clocks
const clockConfig = [
    { id: 'utc', label: 'ZULU (UTC)', zone: 'UTC', enabled: true },
    { id: 'est', label: 'NYC (EST)', zone: 'America/New_York', enabled: true },
    { id: 'lon', label: 'LON (GMT)', zone: 'Europe/London', enabled: false },
    { id: 'tok', label: 'TOK (JST)', zone: 'Asia/Tokyo', enabled: false },
    { id: 'lax', label: 'LAX (PST)', zone: 'America/Los_Angeles', enabled: false },
    { id: 'dxb', label: 'DXB (GST)', zone: 'Asia/Dubai', enabled: false }
];

// Load Saved Preferences
const savedClocks = localStorage.getItem('wh_clocks');
if (savedClocks) {
    const savedStates = JSON.parse(savedClocks);
    clockConfig.forEach(c => {
        if (savedStates[c.id] !== undefined) c.enabled = savedStates[c.id];
    });
}

// Render Clocks in Header
function renderClockBar() {
    const bar = document.getElementById('clock-bar');
    bar.innerHTML = '';
    clockConfig.forEach(c => {
        if (c.enabled) {
            const div = document.createElement('div');
            div.className = 'clock-item';
            div.innerHTML = `
                <span class="clock-label">${c.label}</span>
                <span class="clock-time" id="time-${c.id}">--:--</span>
            `;
            bar.appendChild(div);
        }
    });
    updateClocks();
}

// Render Settings Checkboxes
function renderClockSettings() {
    const container = document.getElementById('clock-toggles');
    container.innerHTML = '';
    clockConfig.forEach(c => {
        const row = document.createElement('label');
        row.className = 'clock-toggle-row';
        row.innerHTML = `
            <span>${c.label}</span>
            <input type="checkbox" ${c.enabled ? 'checked' : ''}>
        `;
        row.querySelector('input').addEventListener('change', (e) => {
            c.enabled = e.target.checked;
            localStorage.setItem('wh_clocks', JSON.stringify(
                clockConfig.reduce((acc, cur) => ({...acc, [cur.id]: cur.enabled}), {})
            ));
            renderClockBar();
        });
        row.addEventListener('click', (e) => e.stopPropagation());
        container.appendChild(row);
    });
}

// Update Time Loop (1Hz)
function updateClocks() {
    const now = new Date();
    clockConfig.forEach(c => {
        if (c.enabled) {
            const el = document.getElementById(`time-${c.id}`);
            if (el) {
                el.innerText = new Intl.DateTimeFormat('en-US', {
                    timeZone: c.zone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
                }).format(now);
            }
        }
    });
}
setInterval(updateClocks, 1000);


// ==================================================================
// 3. MAP INITIALIZATION
// ==================================================================
// Metwatch Map
const map = L.map('map').setView([38, -95], 4);

// Forecast Map
const fcstMap = L.map('map-forecast').setView([38, -95], 4);

// Tile Layers
const darkUrl = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const lightUrl = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';

const darkTiles = L.tileLayer(darkUrl, { attribution: '&copy; CARTO', maxZoom: 19 });
const lightTiles = L.tileLayer(lightUrl, { attribution: '&copy; OSM' });
const fcstDarkTiles = L.tileLayer(darkUrl, { attribution: '&copy; CARTO', maxZoom: 19 });
const fcstLightTiles = L.tileLayer(lightUrl, { attribution: '&copy; OSM' });

darkTiles.addTo(map);
fcstDarkTiles.addTo(fcstMap);

// Marker Layer (Crucial for keeping dots on top of radar)
const markersLayer = L.layerGroup().addTo(map);


// ==================================================================
// 4. RADAR (ANIMATION) & SATELLITE ENGINE
// ==================================================================
// Controls
const timelineContainer = document.getElementById('radar-timeline');
const playBtn = document.getElementById('radar-play');
const slider = document.getElementById('radar-slider');
const timeLabel = document.getElementById('radar-time');
const btnRadar = document.getElementById('btn-radar');
const btnSat = document.getElementById('btn-sat');

// --- SATELLITE (Static WMS) ---
const satLayer = L.tileLayer.wms("https://mesonet.agron.iastate.edu/cgi-bin/wms/goes/east04.cgi?", {
    layers: 'band13', format: 'image/png', transparent: true, opacity: 0.5, attribution: 'NOAA/NASA'
});

btnSat.addEventListener('click', () => {
    if (map.hasLayer(satLayer)) {
        map.removeLayer(satLayer);
        btnSat.classList.remove('active');
    } else {
        satLayer.addTo(map);
        satLayer.bringToFront();
        markersLayer.bringToFront(); // Keep dots on top
        btnSat.classList.add('active');
    }
});

// --- RADAR (RainViewer Animation) ---

// A. Fetch Frames
async function fetchRadarFrames() {
    try {
        const response = await fetch(RAINVIEWER_API);
        const data = await response.json();
        // Get past data (usually 2 hours)
        radarFrames = data.radar.past; 
        
        // Init Slider
        slider.max = radarFrames.length - 1;
        slider.value = radarFrames.length - 1;
        currentFrameIndex = radarFrames.length - 1;
        console.log(`Radar: Loaded ${radarFrames.length} frames.`);
    } catch (e) {
        console.error("Radar fetch failed", e);
    }
}

// B. Show Specific Frame
function showRadarFrame(index) {
    if (!radarVisible) return;

    const ts = radarFrames[index].time;
    
    // Create layer if not cached
    if (!radarLayers[ts]) {
        radarLayers[ts] = L.tileLayer(`https://tile.rainviewer.com/${ts}/256/{z}/{x}/{y}/6/1_1.png`, {
            opacity: 0.7, zIndex: 100 
        });
    }

    // Clear others
    Object.values(radarLayers).forEach(layer => {
        if (map.hasLayer(layer)) map.removeLayer(layer);
    });

    // Add new
    radarLayers[ts].addTo(map);
    markersLayer.bringToFront(); // Markers always on top

    // Update UI
    const date = new Date(ts * 1000);
    timeLabel.innerText = date.toISOString().substr(11, 5) + " Z";
    slider.value = index;
}

// C. Animation Loop
function togglePlay() {
    isPlaying = !isPlaying;
    playBtn.innerText = isPlaying ? "⏸" : "▶";
    
    if (isPlaying) {
        animationTimer = setInterval(() => {
            currentFrameIndex++;
            if (currentFrameIndex >= radarFrames.length) currentFrameIndex = 0;
            showRadarFrame(currentFrameIndex);
        }, 500);
    } else {
        clearInterval(animationTimer);
    }
}

// D. Event Listeners
playBtn.addEventListener('click', togglePlay);
slider.addEventListener('input', (e) => {
    if (isPlaying) togglePlay(); // Pause on drag
    currentFrameIndex = parseInt(e.target.value);
    showRadarFrame(currentFrameIndex);
});

// E. Main Toggle Button
btnRadar.addEventListener('click', async () => {
    radarVisible = !radarVisible;
    
    if (radarVisible) {
        btnRadar.classList.add('active');
        timelineContainer.classList.remove('hidden');
        
        if (radarFrames.length === 0) await fetchRadarFrames();
        showRadarFrame(currentFrameIndex);
    } else {
        btnRadar.classList.remove('active');
        timelineContainer.classList.add('hidden');
        
        if (isPlaying) togglePlay(); // Stop loop
        Object.values(radarLayers).forEach(l => map.removeLayer(l)); // Clear map
    }
});


// ==================================================================
// 5. AVIATION DATA (METAR/TAF)
// ==================================================================
async function fetchRealData() {
    const feed = document.getElementById('obs-feed');
    feed.innerHTML = '<div style="padding:1rem; color:#888;">Contacting NOAA...</div>';

    try {
        const [metarRes, tafRes] = await Promise.all([
            fetch(METAR_URL), fetch(TAF_URL)
        ]);

        if (!metarRes.ok || !tafRes.ok) throw new Error("Network response failed");

        const metars = await metarRes.json();
        const tafs = await tafRes.json();

        console.log(`Received ${metars.length} METARs.`);

        aviationData = metars.map(m => {
            const matchingTaf = tafs.find(t => t.icaoId === m.icaoId);
            return {
                id: m.icaoId,
                name: m.name || m.icaoId,
                lat: m.lat, lon: m.lon,
                cat: m.fltCat || "UNK",
                metar: m.rawOb,
                taf: matchingTaf ? matchingTaf.rawTAF : "TAF NOT AVAILABLE"
            };
        });

        renderSidebar();
        renderMapMarkers();

    } catch (error) {
        console.error("Fetch Error:", error);
        feed.innerHTML = `<div style="padding:1rem; color: #e74c3c;">Load Failed<br><small>${error.message}</small></div>`;
    }
}


// ==================================================================
// 6. RENDERING LOGIC (Sidebar & Markers)
// ==================================================================
function getCatColor(cat) {
    switch(cat) {
        case 'VFR': return '#2ecc71'; case 'MVFR': return '#3498db'; case 'IFR': return '#e74c3c'; case 'LIFR': return '#9b59b6'; default: return '#7f8c8d';
    }
}

function formatTaf(tafString) {
    if (!tafString) return "";
    return tafString.replace(/\s(FM|BECMG|TEMPO|PROB)/g, '<br>&nbsp;&nbsp;$1');
}

let currentMode = 'METAR';
const btnMetar = document.getElementById('tab-metar');
const btnTaf = document.getElementById('tab-taf');

function renderSidebar() {
    const feed = document.getElementById('obs-feed');
    feed.innerHTML = '';
    if (aviationData.length === 0) return;

    aviationData.forEach(station => {
        const card = document.createElement('div');
        const catClass = station.cat ? station.cat.toLowerCase() : 'unk';
        card.className = `obs-card ${catClass}`;
        
        let textContent = currentMode === 'METAR' ? station.metar : formatTaf(station.taf);
        let label = currentMode === 'METAR' ? 'OBS' : 'TAF';

        card.innerHTML = `
            <div class="obs-header">
                <span class="station-id">${station.id}</span>
                <div style="display:flex; gap:5px;">
                    <span class="flight-cat">${station.cat || 'N/A'}</span>
                </div>
            </div>
            <div class="data-label">${label}</div>
            <div class="raw-text">${textContent}</div>
        `;
        
        card.addEventListener('click', () => map.flyTo([station.lat, station.lon], 10));
        feed.appendChild(card);
    });
}

function renderMapMarkers() {
    markersLayer.clearLayers();
    aviationData.forEach(station => {
        const color = getCatColor(station.cat);
        const circleMarker = L.circleMarker([station.lat, station.lon], {
            color: color, fillColor: color, fillOpacity: 0.8, radius: 8
        });

        const formattedTaf = formatTaf(station.taf);
        circleMarker.bindPopup(`
            <div style="font-family: 'Inter', sans-serif; min-width: 280px;">
                <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                    <strong>${station.id}</strong>
                    <span style="background:${color}; color:#000; padding:2px 6px; font-size:0.7rem; border-radius:2px;">${station.cat}</span>
                </div>
                <div style="font-size:0.7rem; color:#888; margin-bottom:2px;">METAR</div>
                <div style="font-family: monospace; margin-bottom:10px; background:rgba(0,0,0,0.05); padding:4px; line-height:1.3;">${station.metar}</div>
                <div style="font-size:0.7rem; color:#888; margin-bottom:2px;">TAF</div>
                <div style="font-family: monospace; background:rgba(0,0,0,0.05); padding:4px; line-height:1.3;">${formattedTaf}</div>
            </div>
        `);
        markersLayer.addLayer(circleMarker);
    });
}

// Tab Switching
function switchTab(mode) {
    currentMode = mode;
    renderSidebar();
    if (mode === 'METAR') {
        btnMetar.classList.add('active');
        btnTaf.classList.remove('active');
    } else {
        btnTaf.classList.add('active');
        btnMetar.classList.remove('active');
    }
}
btnMetar.addEventListener('click', () => switchTab('METAR'));
btnTaf.addEventListener('click', () => switchTab('TAF'));


// ==================================================================
// 7. APP NAVIGATION & SETTINGS
// ==================================================================
const pageMetwatch = document.getElementById('page-metwatch');
const pageForecast = document.getElementById('page-forecast');
const navMetwatch = document.getElementById('nav-metwatch');
const navForecast = document.getElementById('nav-forecast');

function switchPage(pageName) {
    if (pageName === 'metwatch') {
        pageMetwatch.classList.remove('hidden');
        pageForecast.classList.add('hidden');
        navMetwatch.classList.add('active');
        navForecast.classList.remove('active');
    } else {
        pageMetwatch.classList.add('hidden');
        pageForecast.classList.remove('hidden');
        navMetwatch.classList.remove('active');
        navForecast.classList.add('active');
        setTimeout(() => fcstMap.invalidateSize(), 100);
    }
}
navMetwatch.addEventListener('click', () => switchPage('metwatch'));
navForecast.addEventListener('click', () => switchPage('forecast'));

// Settings Dropdown
const settingsBtn = document.getElementById('settings-btn');
const dropdown = document.getElementById('settings-dropdown');

settingsBtn.addEventListener('click', () => dropdown.classList.toggle('hidden'));
document.addEventListener('click', (e) => {
    if (!settingsBtn.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.classList.add('hidden');
    }
});

// Theme Logic
const btnLight = document.getElementById('btn-light');
const btnDark = document.getElementById('btn-dark');

function setTheme(theme) {
    document.body.setAttribute('data-theme', theme);
    dropdown.classList.add('hidden');
    if(theme === 'light') {
        map.removeLayer(darkTiles); lightTiles.addTo(map);
        fcstMap.removeLayer(fcstDarkTiles); fcstLightTiles.addTo(fcstMap);
    } else {
        map.removeLayer(lightTiles); darkTiles.addTo(map);
        fcstMap.removeLayer(fcstLightTiles); fcstDarkTiles.addTo(fcstMap);
    }
}
btnLight.addEventListener('click', () => setTheme('light'));
btnDark.addEventListener('click', () => setTheme('dark'));


// ==================================================================
// 8. FORECAST MODAL
// ==================================================================
const modal = document.getElementById('data-modal');
const modalClose = document.getElementById('modal-close');
const modalTitle = document.getElementById('modal-title');
const modalBody = document.getElementById('modal-body');

fcstMap.on('click', function(e) {
    const selectedTool = document.querySelector('input[name="fcst-tool"]:checked').value;
    const lat = e.latlng.lat.toFixed(2);
    const lon = e.latlng.lng.toFixed(2);
    modal.classList.remove('hidden');

    let content = "";
    if (selectedTool === 'skewt') {
        modalTitle.innerText = `Sounding @ ${lat}, ${lon}`;
        content = `<div style="text-align:center; padding:2rem;"><div style="font-size:3rem;">📈</div>Generating Skew-T Log-P...</div>`;
    } else if (selectedTool === 'meteogram') {
        modalTitle.innerText = `Meteogram @ ${lat}, ${lon}`;
        content = `<div style="text-align:center; padding:2rem;"><div style="font-size:3rem;">📊</div>Generating Meteogram...</div>`;
    } else {
        modalTitle.innerText = `Cross Section @ ${lat}, ${lon}`;
        content = `<div style="padding:2rem;">Cross Section Data...</div>`;
    }
    modalBody.innerHTML = content;
});
modalClose.addEventListener('click', () => modal.classList.add('hidden'));
modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });


// ==================================================================
// 9. INITIAL START
// ==================================================================
renderClockBar();
renderClockSettings();
fetchRealData();