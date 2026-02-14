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

// UPDATED: Break-even based on 260 working days, not 365 calendar days
const ANNUAL_PASS = 1788;
const WORKING_DAYS = 260; // 52 weeks × 5 days (realistic commuting pattern)
const DAILY_BREAK_EVEN = ANNUAL_PASS / WORKING_DAYS; // £6.88 (not £4.91)

// Keep legacy constant for backwards compatibility
const WEEKLY_PASS = ANNUAL_PASS / 52;
const DAILY_PASS = DAILY_BREAK_EVEN; // Updated to use correct break-even

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
            passWorthIt: paygCost > DAILY_BREAK_EVEN, // UPDATED: Now uses £6.88 instead of £4.91
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
        passCost = DAILY_BREAK_EVEN * calendarDays; // UPDATED: Uses £6.88
        nonTravelDays = calendarDays - travelDays;
    }

    const passWinDays = summaries.filter(d => d.passWorthIt).length;
    const paygWinDays = summaries.filter(d => !d.passWorthIt).length;
    const savings = passCost - totalPayg;
    const cappedSavings = totalUncapped - totalPayg;
    const nonTravelSavings = nonTravelDays * DAILY_BREAK_EVEN; // UPDATED: Uses £6.88

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
        jDate.setHours(0, 0,
