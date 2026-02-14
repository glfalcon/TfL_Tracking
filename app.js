// TfL Spend & Savings Dashboard - Shared Application Logic
// Shared between desktop (index.html) and mobile (mobile.html)

// ============================================================
// GOOGLE SHEETS CONFIG
// ============================================================
// Same GCP project as Energy Tracker. Create a NEW sheet for TfL data.
// Sheet name: "Journeys" with columns:
// A: Date | B: Start Time | C: End Time | D: Journey/Action | E: Charge | F: Credit | G: Balance | H: Note
// This matches the TfL CSV export exactly — just paste your CSV data in.
const GOOGLE_CONFIG = {
    clientId: '531203228430-94fbaf0bc30tkp211gvac6ihbk4cc1do.apps.googleusercontent.com',
    apiKey: 'AIzaSyCzPYl9wWf3l4MTWpOpjCm7ZKu8h75Wmn4',
    discoveryDocs: ['https://sheets.googleapis.com/$discovery/rest?version=v4'],
    scopes: 'https://www.googleapis.com/auth/spreadsheets',
    spreadsheetId: '1U37dsFpW7nTRoxEwex6wHeXxLloLuVvbev9Cj-vqGTE'
};

let gapiInited = false;
let gisInited = false;
let tokenClient;
let accessToken = null;

// ============================================================
// TFL FARE CONSTANTS
// ============================================================
const RATES = {
    BUS: 1.75,
    TUBE_PEAK: 3.10,
    TUBE_OFFPEAK: 3.00,
};

const CAPS = {
    DAILY: 8.90,
    WEEKLY: 44.70,
    BUS_ONLY: 5.25,
};

const ANNUAL_PASS = 1788;
const WEEKLY_PASS = ANNUAL_PASS / 52;
const DAILY_PASS = WEEKLY_PASS / 7; // ~£4.91

// ============================================================
// DATA STORAGE (localStorage)
// ============================================================
const STORAGE_KEY = 'tfl-journeys';

function saveJourneys(journeys) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(journeys));
}

function loadJourneys() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return [];
    try {
        const parsed = JSON.parse(saved);
        return parsed.map(j => ({
            ...j,
            timestamp: new Date(j.timestamp)
        }));
    } catch (e) {
        return [];
    }
}

// Global journeys array
let journeys = [];

// ============================================================
// CSV PARSING (TfL export format)
// ============================================================
function parseCSVLine(line) {
    const fields = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            if (inQuotes && line[i + 1] === '"') {
                current += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === ',' && !inQuotes) {
            fields.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    fields.push(current.trim());
    return fields;
}

function parseCSVDate(dateStr, timeStr) {
    const months = {
        'Jan': 0, 'Feb': 1, 'Mar': 2, 'Apr': 3, 'May': 4, 'Jun': 5,
        'Jul': 6, 'Aug': 7, 'Sep': 8, 'Oct': 9, 'Nov': 10, 'Dec': 11
    };
    const parts = dateStr.split('-');
    const day = parseInt(parts[0]);
    const month = months[parts[1]];
    const year = parseInt(parts[2]);

    let hours = 0, minutes = 0;
    if (timeStr && timeStr.includes(':')) {
        const timeParts = timeStr.split(':');
        hours = parseInt(timeParts[0]);
        minutes = parseInt(timeParts[1]);
    }

    return new Date(year, month, day, hours, minutes);
}

function isPeakTime(date) {
    const day = date.getDay();
    if (day === 0 || day === 6) return false;
    const hours = date.getHours();
    const mins = date.getMinutes();
    const timeInMinutes = hours * 60 + mins;
    return (timeInMinutes >= 390 && timeInMinutes <= 570) ||
           (timeInMinutes >= 960 && timeInMinutes <= 1140);
}

function parseCSVText(csvText) {
    const lines = csvText.split('\n').filter(l => l.trim());
    const imported = [];

    let startIdx = 0;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('Date') && lines[i].includes('Journey/Action')) {
            startIdx = i + 1;
            break;
        }
    }

    for (let i = startIdx; i < lines.length; i++) {
        const fields = parseCSVLine(lines[i]);
        if (fields.length < 5) continue;

        const [dateStr, startTime, , journeyAction, chargeStr] = fields;
        if (!dateStr || !journeyAction) continue;

        const timestamp = parseCSVDate(dateStr, startTime);
        const actualCharge = parseFloat(chargeStr) || 0;

        const isBus = journeyAction.toLowerCase().includes('bus journey');
        let type, cost, route, startStation, endStation;

        if (isBus) {
            type = 'bus';
            cost = RATES.BUS;
            const routeMatch = journeyAction.match(/route\s+(\S+)/i);
            route = routeMatch ? routeMatch[1] : undefined;
        } else {
            type = isPeakTime(timestamp) ? 'tube-peak' : 'tube-offpeak';
            cost = type === 'tube-peak' ? RATES.TUBE_PEAK : RATES.TUBE_OFFPEAK;
            const stationMatch = journeyAction.match(/(.+?)\s+to\s+(.+)/i);
            if (stationMatch) {
                startStation = stationMatch[1];
                endStation = stationMatch[2];
            }
        }

        if (actualCharge > 0 && actualCharge > cost) {
            cost = actualCharge;
        }

        imported.push({
            id: `csv-${dateStr}-${startTime}-${i}`,
            timestamp,
            type,
            cost,
            description: journeyAction,
            source: 'csv-import',
            route,
            startStation,
            endStation,
            actualCharge,
        });
    }

    return imported;
}

// Parse Google Sheets rows (same format as CSV but already split into columns)
function parseSheetsRows(rows) {
    const imported = [];

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row.length < 5) continue;

        const [dateStr, startTime, , journeyAction, chargeStr] = row;
        if (!dateStr || !journeyAction) continue;

        // Skip header row if present
        if (dateStr === 'Date') continue;

        const timestamp = parseCSVDate(dateStr, startTime || '');
        const actualCharge = parseFloat(chargeStr) || 0;

        const isBus = journeyAction.toLowerCase().includes('bus journey');
        let type, cost, route, startStation, endStation;

        if (isBus) {
            type = 'bus';
            cost = RATES.BUS;
            const routeMatch = journeyAction.match(/route\s+(\S+)/i);
            route = routeMatch ? routeMatch[1] : undefined;
        } else {
            type = isPeakTime(timestamp) ? 'tube-peak' : 'tube-offpeak';
            cost = type === 'tube-peak' ? RATES.TUBE_PEAK : RATES.TUBE_OFFPEAK;
            const stationMatch = journeyAction.match(/(.+?)\s+to\s+(.+)/i);
            if (stationMatch) {
                startStation = stationMatch[1];
                endStation = stationMatch[2];
            }
        }

        if (actualCharge > 0 && actualCharge > cost) {
            cost = actualCharge;
        }

        imported.push({
            id: `sheet-${dateStr}-${startTime}-${i}`,
            timestamp,
            type,
            cost,
            description: journeyAction,
            source: 'csv-import',
            route,
            startStation,
            endStation,
            actualCharge,
        });
    }

    return imported;
}

// ============================================================
// FARE CALCULATION LOGIC
// ============================================================
function calculateDailyCost(dayJourneys) {
    let cost = 0;
    let lastBusTime = null;

    const sorted = [...dayJourneys].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    for (const journey of sorted) {
        if (journey.type === 'bus') {
            if (lastBusTime) {
                const diffMinutes = (journey.timestamp.getTime() - lastBusTime.getTime()) / 60000;
                if (diffMinutes <= 60) continue; // Hopper — free!
            }
            cost += RATES.BUS;
            lastBusTime = journey.timestamp;
        } else {
            cost += journey.cost;
        }
    }

    return Math.min(cost, CAPS.DAILY);
}

function calculateUncappedCost(dayJourneys) {
    let cost = 0;
    let lastBusTime = null;

    const sorted = [...dayJourneys].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    for (const journey of sorted) {
        if (journey.type === 'bus') {
            if (lastBusTime) {
                const diffMinutes = (journey.timestamp.getTime() - lastBusTime.getTime()) / 60000;
                if (diffMinutes <= 60) continue;
            }
            cost += RATES.BUS;
            lastBusTime = journey.timestamp;
        } else {
            cost += journey.cost;
        }
    }

    return cost;
}

// ============================================================
// ANALYTICS
// ============================================================
function getDailySummaries(journeyList) {
    const dayMap = {};

    journeyList.forEach(j => {
        const d = new Date(j.timestamp);
        d.setHours(0, 0, 0, 0);
        const key = d.toISOString();
        if (!dayMap[key]) dayMap[key] = [];
        dayMap[key].push(j);
    });

    const summaries = [];
    Object.keys(dayMap).forEach(key => {
        const dayJourneys = dayMap[key];
        const date = new Date(key);
        const paygCost = calculateDailyCost(dayJourneys);
        const uncappedCost = calculateUncappedCost(dayJourneys);

        summaries.push({
            date,
            dateStr: date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }),
            dateShort: date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
            journeys: dayJourneys.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()),
            paygCost,
            capped: uncappedCost > CAPS.DAILY,
            overCap: Math.max(0, uncappedCost - CAPS.DAILY),
            journeyCount: dayJourneys.length,
            passWorthIt: paygCost > DAILY_PASS,
        });
    });

    return summaries.sort((a, b) => b.date.getTime() - a.date.getTime());
}

function getOverallStats(summaries) {
    const totalPayg = summaries.reduce((sum, d) => sum + d.paygCost, 0);
    const totalUncapped = summaries.reduce((sum, d) => sum + d.paygCost + d.overCap, 0);
    const cappedDays = summaries.filter(d => d.capped).length;
    const travelDays = summaries.length;
    const totalJourneys = summaries.reduce((sum, d) => sum + d.journeyCount, 0);

    let calendarDays = 0, passCost = 0, nonTravelDays = 0;
    if (summaries.length > 0) {
        const firstDate = summaries[summaries.length - 1].date;
        const lastDate = summaries[0].date;
        calendarDays = Math.ceil((lastDate.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
        passCost = DAILY_PASS * calendarDays;
        nonTravelDays = calendarDays - travelDays;
    }

    const passWinDays = summaries.filter(d => d.passWorthIt).length;
    const paygWinDays = summaries.filter(d => !d.passWorthIt).length;
    const savings = passCost - totalPayg;
    const cappedSavings = totalUncapped - totalPayg;
    const nonTravelSavings = nonTravelDays * DAILY_PASS;

    return {
        totalPayg, totalUncapped, cappedDays, travelDays, calendarDays,
        nonTravelDays, totalJourneys, passCost, savings, cappedSavings,
        passWinDays, paygWinDays, nonTravelSavings,
    };
}

function getTodayJourneys() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return journeys.filter(j => {
        const jDate = new Date(j.timestamp);
        jDate.setHours(0, 0, 0, 0);
        return jDate.getTime() === today.getTime();
    }).sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
}

function getTodayCost() {
    return calculateDailyCost(getTodayJourneys());
}

// ============================================================
// MANUAL JOURNEY LOGGING
// ============================================================
function addJourney(type) {
    const descriptions = {
        'bus': 'Bus journey',
        'tube-peak': 'Tube journey (Peak)',
        'tube-offpeak': 'Tube journey (Off-peak)'
    };
    const costs = {
        'bus': RATES.BUS,
        'tube-peak': RATES.TUBE_PEAK,
        'tube-offpeak': RATES.TUBE_OFFPEAK
    };

    const journey = {
        id: Math.random().toString(36).substr(2, 9),
        timestamp: new Date(),
        type,
        cost: costs[type],
        description: descriptions[type],
        source: 'manual',
    };

    journeys.unshift(journey);
    saveJourneys(journeys);
    displayDashboard();
    closeModal();
}

function deleteJourney(id) {
    journeys = journeys.filter(j => j.id !== id);
    saveJourneys(journeys);
    displayDashboard();
}

// ============================================================
// CSV IMPORT / EXPORT
// ============================================================
function handleCSVImport(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        const text = e.target.result;
        const imported = parseCSVText(text);

        if (imported.length === 0) {
            showImportSummary('No journeys found in file. Check the CSV format.', true);
            return;
        }

        const existingIds = new Set(journeys.map(j => j.id));
        const newJourneys = imported.filter(j => !existingIds.has(j.id));
        journeys = [...journeys, ...newJourneys].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
        saveJourneys(journeys);

        const dates = imported.map(j => j.timestamp);
        const earliest = new Date(Math.min(...dates.map(d => d.getTime())));
        const latest = new Date(Math.max(...dates.map(d => d.getTime())));

        showImportSummary(
            `Imported ${newJourneys.length} new journeys (${imported.length} in file) from ${earliest.toLocaleDateString('en-GB')} to ${latest.toLocaleDateString('en-GB')}`
        );
        displayDashboard();
    };
    reader.readAsText(file);
    event.target.value = '';
}

function exportCSV() {
    const headers = 'Date,Time,Type,Description,Cost,Source\n';
    const rows = journeys
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
        .map(j => {
            const date = j.timestamp.toLocaleDateString('en-GB');
            const time = j.timestamp.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
            return `${date},${time},${j.type},"${j.description}",${j.cost.toFixed(2)},${j.source || 'manual'}`;
        })
        .join('\n');

    const blob = new Blob([headers + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tfl-journeys-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

function showImportSummary(message, isError) {
    const el = document.getElementById('importSummary');
    if (!el) return;
    el.textContent = message;
    el.className = 'import-summary ' + (isError ? 'error' : 'success');
    el.style.display = 'flex';
    setTimeout(() => { el.style.display = 'none'; }, 8000);
}

// ============================================================
// GOOGLE SHEETS SYNC (same pattern as Energy Tracker)
// ============================================================
function gapiLoaded() {
    gapi.load('client', initializeGapiClient);
}

async function initializeGapiClient() {
    await gapi.client.init({
        apiKey: GOOGLE_CONFIG.apiKey,
        discoveryDocs: GOOGLE_CONFIG.discoveryDocs,
    });
    gapiInited = true;
    maybeEnableButtons();
}

function gisLoaded() {
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CONFIG.clientId,
        scope: GOOGLE_CONFIG.scopes,
        callback: '',
    });
    gisInited = true;
    maybeEnableButtons();
}

function maybeEnableButtons() {
    if (gapiInited && gisInited) {
        const savedToken = localStorage.getItem('tflTrackerAccessToken');
        if (savedToken) {
            try {
                accessToken = JSON.parse(savedToken);
                gapi.client.setToken(accessToken);
            } catch (e) {
                accessToken = null;
            }
        }
        updateGoogleStatus();
    }
}

function authorizeGoogle() {
    tokenClient.callback = async (resp) => {
        if (resp.error !== undefined) {
            console.error('Auth error:', resp);
            return;
        }
        accessToken = gapi.client.getToken();
        localStorage.setItem('tflTrackerAccessToken', JSON.stringify(accessToken));
        await syncFromSheets();
        updateGoogleStatus();
    };

    if (gapi.client.getToken() === null) {
        tokenClient.requestAccessToken({ prompt: 'consent' });
    } else {
        tokenClient.requestAccessToken({ prompt: '' });
    }
}

async function syncFromSheets() {
    if (!GOOGLE_CONFIG.spreadsheetId || !accessToken) return false;

    try {
        const response = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: GOOGLE_CONFIG.spreadsheetId,
            range: 'Journeys!A:H',
        });

        const rows = response.result.values;
        if (!rows || rows.length === 0) return false;

        // Skip header row
        const dataRows = rows[0][0] === 'Date' ? rows.slice(1) : rows;
        const imported = parseSheetsRows(dataRows);

        if (imported.length === 0) return false;

        // Merge with existing (avoid duplicates)
        const existingIds = new Set(journeys.map(j => j.id));
        const newJourneys = imported.filter(j => !existingIds.has(j.id));
        journeys = [...journeys, ...newJourneys].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
        saveJourneys(journeys);

        localStorage.setItem('tflLastSync', new Date().toISOString());
        displayDashboard();
        showImportSummary(`Synced ${newJourneys.length} new journeys from Google Sheets`);
        return true;
    } catch (err) {
        console.error('Error syncing from sheets:', err);
        return false;
    }
}

async function syncData() {
    const statusText = document.getElementById('statusText');
    if (statusText) statusText.textContent = '🔄 Syncing...';
    await syncFromSheets();
    updateGoogleStatus();
}

function updateGoogleStatus() {
    const statusText = document.getElementById('statusText');
    const lastSyncText = document.getElementById('lastSyncText');
    const syncBtn = document.getElementById('syncBtn');
    const connectBtn = document.getElementById('connectBtn');

    if (!statusText) return;

    if (accessToken && GOOGLE_CONFIG.spreadsheetId) {
        statusText.textContent = '✅ Connected to Google Sheets';
        if (syncBtn) syncBtn.style.display = 'inline-block';
        if (connectBtn) connectBtn.textContent = 'Reconnect';

        const lastSync = localStorage.getItem('tflLastSync');
        if (lastSync && lastSyncText) {
            const syncDate = new Date(lastSync);
            lastSyncText.textContent = `Last sync: ${syncDate.toLocaleString('en-GB')}`;
        }
    } else if (!GOOGLE_CONFIG.spreadsheetId) {
        statusText.textContent = '⚙️ Set spreadsheetId in app.js';
        if (syncBtn) syncBtn.style.display = 'none';
    } else {
        statusText.textContent = '📱 Not connected to Google Sheets';
        if (syncBtn) syncBtn.style.display = 'none';
    }
}

// ============================================================
// UI HELPERS
// ============================================================
function openModal() {
    const modal = document.getElementById('journeyModal');
    if (modal) modal.style.display = 'flex';
}

function closeModal() {
    const modal = document.getElementById('journeyModal');
    if (modal) modal.style.display = 'none';
}

function formatCurrency(amount) {
    return '£' + amount.toFixed(2);
}

// ============================================================
// MAIN DISPLAY (called by both desktop and mobile)
// ============================================================
function displayDashboard() {
    const summaries = getDailySummaries(journeys);
    const stats = getOverallStats(summaries);
    const todayCost = getTodayCost();
    const capProgress = Math.min((todayCost / CAPS.DAILY) * 100, 100);
    const isCapped = todayCost >= CAPS.DAILY;

    // -- Verdict widget --
    const verdictEl = document.getElementById('verdict');
    if (verdictEl) {
        if (journeys.length === 0) {
            verdictEl.style.display = 'none';
        } else {
            verdictEl.style.display = 'block';
            const isPassWorthIt = stats.savings <= 0;

            const verdictIconEl = document.getElementById('verdictIcon');
            if (verdictIconEl) {
                verdictIconEl.textContent = isPassWorthIt ? '✅' : '⚠️';
                verdictIconEl.className = 'verdict-icon ' + (isPassWorthIt ? 'good' : 'warn');
            }
            const verdictTitleEl = document.getElementById('verdictTitle');
            if (verdictTitleEl) verdictTitleEl.textContent = 'Is Your Annual Pass Worth It?';
            const verdictSubEl = document.getElementById('verdictSub');
            if (verdictSubEl) verdictSubEl.textContent = `Zone 1–2 Annual Travelcard: £${ANNUAL_PASS.toLocaleString()}/yr = ${formatCurrency(DAILY_PASS)}/day`;

            const verdictBox = document.getElementById('verdictBox');
            if (isPassWorthIt) {
                verdictBox.className = 'verdict-box good';
                verdictBox.innerHTML = `<span class="verdict-amount">✅ Pass is saving you ${formatCurrency(Math.abs(stats.savings))}</span><span class="verdict-desc">Your PAYG would cost more than the annual pass over this period</span>`;
            } else {
                verdictBox.className = 'verdict-box warn';
                verdictBox.innerHTML = `<span class="verdict-amount">⚠️ PAYG would save you ${formatCurrency(stats.savings)}</span><span class="verdict-desc">You could save money by switching to Pay As You Go</span>`;
            }

            document.getElementById('statPayg').textContent = formatCurrency(stats.totalPayg);
            document.getElementById('statPaygDays').textContent = `${stats.travelDays} travel days`;
            document.getElementById('statPass').textContent = formatCurrency(stats.passCost);
            document.getElementById('statPassDays').textContent = `${stats.calendarDays} calendar days × ${formatCurrency(DAILY_PASS)}`;
            document.getElementById('statPassWin').textContent = `${stats.passWinDays} days`;
            document.getElementById('statPaygWin').textContent = `${stats.paygWinDays} days`;
            document.getElementById('statNoTravel').textContent = `${stats.nonTravelDays}`;
            document.getElementById('statNoTravelCost').textContent = `${formatCurrency(stats.nonTravelSavings)} wasted`;
            document.getElementById('statTotalJourneys').textContent = `${stats.totalJourneys}`;
            document.getElementById('statTotalJourneysSub').textContent = `across ${stats.travelDays} days`;
        }
    }

    // -- Cap meter --
    const capCircle = document.getElementById('capCircle');
    if (capCircle) {
        const circumference = 2 * Math.PI * 88;
        capCircle.style.strokeDasharray = circumference;
        capCircle.style.strokeDashoffset = circumference * (1 - capProgress / 100);
        capCircle.setAttribute('class', isCapped ? 'cap-progress capped' : 'cap-progress');
    }
    const capAmount = document.getElementById('capAmount');
    if (capAmount) capAmount.textContent = formatCurrency(todayCost);
    const capStatus = document.getElementById('capStatus');
    if (capStatus) {
        if (isCapped) {
            capStatus.className = 'cap-status capped';
            capStatus.textContent = '🎉 CAPPED — FREE TRAVEL UNLOCKED';
        } else {
            capStatus.className = 'cap-status';
            capStatus.textContent = `${formatCurrency(CAPS.DAILY - todayCost)} until cap`;
        }
    }

    // -- Today's journeys --
    const todayList = document.getElementById('todayList');
    if (todayList) {
        const todayJ = getTodayJourneys();
        if (todayJ.length === 0) {
            todayList.innerHTML = '<div class="empty-state">No journeys logged today<br><small>Tap + to add one, or import your TfL CSV</small></div>';
        } else {
            todayList.innerHTML = todayJ.map(j => journeyRowHTML(j)).join('');
        }
    }

    // -- History --
    displayHistory(summaries);

    // -- Analysis --
    displayAnalysis(summaries);

    // -- Chart --
    renderChart(summaries);
}

function journeyRowHTML(j, compact) {
    const icon = j.type === 'bus' ? '🚌' : '🚇';
    const colorClass = j.type === 'bus' ? 'bus' : 'tube';
    const time = j.timestamp.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const sourceTag = j.source === 'csv-import' ? '<span class="tag csv">CSV</span>' : '';

    return `
        <div class="journey-row ${compact ? 'compact' : ''} ${colorClass}">
            <div class="journey-left">
                <span class="journey-icon">${icon}</span>
                <div>
                    <div class="journey-desc">${j.description}</div>
                    <div class="journey-time">${time} ${sourceTag}</div>
                </div>
            </div>
            <div class="journey-right">
                <span class="journey-cost">${formatCurrency(j.cost)}</span>
                <button class="delete-btn" onclick="deleteJourney('${j.id}')">🗑️</button>
            </div>
        </div>
    `;
}

function displayHistory(summaries) {
    const el = document.getElementById('historyList');
    if (!el) return;

    if (summaries.length === 0) {
        el.innerHTML = '<div class="empty-state">No journey data yet<br><small>Import your TfL CSV to see your history</small></div>';
        return;
    }

    el.innerHTML = summaries.map(day => {
        const badge = day.passWorthIt
            ? '<span class="badge good">✅ Pass worth it</span>'
            : '<span class="badge warn">PAYG cheaper</span>';
        const capNote = day.capped ? `<span class="cap-note">(cap saved ${formatCurrency(day.overCap)})</span>` : '';

        return `
            <div class="day-group">
                <div class="day-header">
                    <div class="day-date">📅 ${day.dateStr}</div>
                    <div class="day-meta">
                        ${badge}
                        <span class="day-cost">${formatCurrency(day.paygCost)} ${capNote}</span>
                    </div>
                </div>
                <div class="day-journeys">
                    ${day.journeys.map(j => journeyRowHTML(j, true)).join('')}
                </div>
            </div>
        `;
    }).join('');
}

function displayAnalysis(summaries) {
    const el = document.getElementById('analysisList');
    if (!el) return;

    if (summaries.length === 0) {
        el.innerHTML = '<div class="empty-state">No data to analyze<br><small>Import your TfL CSV to see the analysis</small></div>';
        return;
    }

    el.innerHTML = summaries.map(day => {
        const cls = day.passWorthIt ? 'good' : 'warn';
        const icon = day.passWorthIt ? '✅' : '⚠️';
        const label = day.passWorthIt ? 'Pass saved you money' : 'PAYG would be cheaper';
        const capNote = day.capped ? `<div class="analysis-cap">Cap saved ${formatCurrency(day.overCap)}</div>` : '';

        return `
            <div class="analysis-row ${cls}">
                <div class="analysis-left">
                    <span class="analysis-icon">${icon}</span>
                    <div>
                        <div class="analysis-date">${day.dateStr}</div>
                        <div class="analysis-sub">${day.journeyCount} journeys • ${label}</div>
                    </div>
                </div>
                <div class="analysis-right">
                    <div class="analysis-cost ${cls}">${formatCurrency(day.paygCost)}</div>
                    <div class="analysis-vs">vs ${formatCurrency(DAILY_PASS)} pass</div>
                    ${capNote}
                </div>
            </div>
        `;
    }).join('');
}

// ============================================================
// CHART (ApexCharts)
// ============================================================
let mainChart = null;

function renderChart(summaries) {
    const container = document.getElementById('mainChart') || document.getElementById('mobileChart');
    if (!container || summaries.length < 2) return;

    const reversed = [...summaries].reverse();
    const labels = reversed.map(s => s.dateShort);
    const costs = reversed.map(s => parseFloat(s.paygCost.toFixed(2)));
    const colors = reversed.map(s => s.passWorthIt ? '#059669' : '#dc2626');

    if (mainChart) mainChart.destroy();

    const options = {
        series: [{ name: 'PAYG Cost', data: costs }],
        chart: {
            type: 'bar',
            height: container.id === 'mobileChart' ? 250 : 350,
            toolbar: { show: false },
            fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
            background: 'transparent',
        },
        colors: ['#818cf8'],
        plotOptions: {
            bar: {
                borderRadius: 4,
                columnWidth: '70%',
                distributed: true,
            }
        },
        fill: { colors: colors },
        xaxis: {
            categories: labels,
            labels: {
                style: { colors: '#94a3b8', fontSize: '10px' },
                rotate: -45,
                rotateAlways: summaries.length > 10,
            },
        },
        yaxis: {
            labels: {
                style: { colors: '#94a3b8' },
                formatter: val => '£' + val.toFixed(0),
            }
        },
        grid: {
            borderColor: '#e5e7eb',
            strokeDashArray: 4,
        },
        annotations: {
            yaxis: [{
                y: DAILY_PASS,
                borderColor: '#d97706',
                borderWidth: 2,
                strokeDashArray: 6,
                label: {
                    text: `Pass: ${formatCurrency(DAILY_PASS)}/day`,
                    position: 'front',
                    offsetX: 0,
                    style: {
                        color: '#fff',
                        background: '#d97706',
                        fontSize: '11px',
                        padding: { left: 8, right: 8, top: 4, bottom: 4 },
                    }
                }
            }]
        },
        dataLabels: { enabled: false },
        legend: { show: false },
        tooltip: {
            theme: 'dark',
            y: { formatter: val => '£' + val.toFixed(2) },
        },
    };

    mainChart = new ApexCharts(container, options);
    mainChart.render();
}

// ============================================================
// APP INIT
// ============================================================
function initApp() {
    journeys = loadJourneys();
    displayDashboard();
    updateGoogleStatus();
}

window.onload = function () {
    if (typeof gapi !== 'undefined') gapiLoaded();
    if (typeof google !== 'undefined') gisLoaded();
    initApp();
};
