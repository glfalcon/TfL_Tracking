# 🚇 TfL Spend & Savings Dashboard

Track your London transport spending and compare Pay-As-You-Go costs against your Zone 1–2 Annual Travelcard (£1,788/year).

## Features

- **Annual Pass Verdict** — Instantly see if your Travelcard is worth it vs PAYG
- **Daily Cap Meter** — Visual ring showing progress toward the £8.90 daily cap
- **PAYG vs Pass Chart** — Bar chart with £4.91/day reference line
- **CSV Import** — Import TfL journey history exports directly
- **Google Sheets Sync** — Keep your data in a Google Sheet for easy management
- **Manual Logging** — Quick-add bus, peak tube, or off-peak tube journeys
- **Desktop & Mobile** — Responsive versions for both form factors

## Files

| File | Purpose |
|------|---------|
| `index.html` | Desktop version (auto-redirects mobile users) |
| `mobile.html` | Mobile version with bottom tab navigation |
| `app.js` | Shared application logic |
| `manifest.json` | PWA manifest for home screen install |

## Setup

### 1. Deploy to GitHub Pages

1. Create a new GitHub repository
2. Push all files to the `main` branch
3. Go to **Settings → Pages → Source** → select `main` branch
4. Your app will be live at `https://<username>.github.io/<repo-name>/`

### 2. Set Up Google Sheets (Optional)

The app stores data in `localStorage` by default. To enable Google Sheets sync:

1. **Create a Google Sheet**
   - Go to [sheets.google.com](https://sheets.google.com) and create a new spreadsheet
   - Name the first sheet tab **"Journeys"**
   - Add these headers in Row 1:

   | A | B | C | D | E | F | G | H |
   |---|---|---|---|---|---|---|---|
   | Date | Start Time | End Time | Journey/Action | Charge | Credit | Balance | Note |

2. **Copy the Spreadsheet ID**
   - From the URL: `https://docs.google.com/spreadsheets/d/`**`YOUR_SPREADSHEET_ID`**`/edit`
   - Open `app.js` and paste it into the `GOOGLE_CONFIG.spreadsheetId` field

3. **GCP Console** (if not already configured)
   - The app uses the same GCP project as the Energy Tracker
   - Ensure your GitHub Pages domain is added as an **Authorized JavaScript Origin** in the OAuth client settings
   - Go to [console.cloud.google.com](https://console.cloud.google.com) → APIs & Services → Credentials
   - Edit the OAuth 2.0 Client ID and add your GitHub Pages URL (e.g., `https://<username>.github.io`)

### 3. Import TfL Data

1. Log into [tfl.gov.uk](https://tfl.gov.uk/travel-information/contactless-and-oyster-payment) and export your journey history as CSV
2. Either:
   - **Direct import**: Click "📥 Import CSV" in the app and select the file
   - **Google Sheets**: Paste the CSV data directly into your "Journeys" sheet (the columns match TfL's export format exactly), then hit "🔄 Sync"

## TfL Fare Logic

| Fare | Amount |
|------|--------|
| Bus | £1.75 |
| Tube (Peak) | £3.10 |
| Tube (Off-Peak) | £3.00 |
| Daily Cap | £8.90 |
| Weekly Cap | £44.70 |
| Hopper (2nd bus within 60min) | Free |

**Peak hours**: Weekdays 06:30–09:30 and 16:00–19:00

**Annual Pass comparison**: £1,788/year ÷ 52 weeks ÷ 7 days = **£4.91/day**

### Color Logic (Annual Pass Holder Perspective)

- 🟢 **Green** = PAYG would cost > £4.91 → your pass saved you money
- 🟠 **Amber** = PAYG would cost ≤ £4.91 → PAYG would have been cheaper
- Non-travel days count as amber (you paid £4.91 for nothing)

## Tech Stack

- **No build step** — pure HTML, CSS, and vanilla JavaScript
- **ApexCharts** (CDN) — for the bar chart
- **Google Sheets API** (CDN) — for cloud data sync
- **localStorage** — for offline/fallback data persistence
- **GitHub Pages** — for hosting
