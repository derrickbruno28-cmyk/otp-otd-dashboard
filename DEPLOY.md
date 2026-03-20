# OTP/OTD Dashboard Deployment Guide

This project is now structured as:

- `public/index.html`: the dashboard UI
- `server.js`: the API server, Postgres integration, and hourly sheet sync
- `db/schema.sql`: the shipments table
- `.env.example`: the required environment variables

## 1. Prepare the project

1. Open Terminal.
2. Run:

```bash
cd "/Users/admindevices/Downloads/OTP-OTD Dashboard"
cp .env.example .env
npm install
```

3. Open `.env` and set:

- `DATABASE_URL`: your Postgres connection string
- `SHEET_URL`: the published CSV or XLSX export URL for your sheet
- `PORT`: leave `3000` unless you need a different port
- `CRON_SCHEDULE`: leave `0 * * * *` for hourly syncs
- `TZ`: leave `America/Chicago` unless needed

## 2. Create Postgres with Supabase

1. Go to [Supabase](https://supabase.com/).
2. Click `Start your project`.
3. Click `New project`.
4. Pick your organization.
5. Enter a project name, choose a strong database password, and choose a region near you.
6. Click `Create new project`.
7. Wait for provisioning to finish.
8. In the left sidebar, click `Connect`.
9. Copy the `URI` connection string.
10. Paste it into `DATABASE_URL` in `.env`.
11. In Supabase, click `SQL Editor`.
12. Click `New query`.
13. Open [db/schema.sql](/Users/admindevices/Downloads/OTP-OTD Dashboard/db/schema.sql).
14. Paste the SQL into Supabase.
15. Click `Run`.

## 3. Publish the Google Sheet for hourly syncing

1. Open your Google Sheet.
2. Click `File`.
3. Click `Share`.
4. Click `Publish to web`.
5. Select the tab that contains the shipment data.
6. Choose `Comma-separated values (.csv)` if available. If not, use the workbook export URL.
7. Click `Publish`.
8. Copy the published sheet URL.
9. Paste it into `SHEET_URL` in `.env`.

If you need the direct CSV export URL, this format works:

```text
https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/export?format=csv&gid=SHEET_GID
```

## 4. Run locally

1. In Terminal, run:

```bash
cd "/Users/admindevices/Downloads/OTP-OTD Dashboard"
npm start
```

2. Open [http://localhost:3000](http://localhost:3000).
3. The dashboard will load from Postgres.
4. To force a sheet sync immediately, open a second Terminal window and run:

```bash
curl -X POST http://localhost:3000/api/sync-sheet
```

## 5. Deploy live on Render

1. Go to [Render](https://render.com/).
2. Click `Get Started for Free`.
3. Connect your GitHub account.
4. Create a new GitHub repository named `otp-otd-dashboard`.
5. In Terminal, run:

```bash
cd "/Users/admindevices/Downloads/OTP-OTD Dashboard"
git init
git add .
git commit -m "Initial OTP/OTD dashboard"
git branch -M main
git remote add origin YOUR_GITHUB_REPO_URL
git push -u origin main
```

6. In Render, click `New +`.
7. Click `Web Service`.
8. Select your GitHub repo.
9. Set:

- `Name`: `otp-otd-dashboard`
- `Environment`: `Node`
- `Build Command`: `npm install`
- `Start Command`: `npm start`

10. In `Environment Variables`, add:

- `DATABASE_URL`
- `SHEET_URL`
- `CRON_SCHEDULE`
- `TZ`
- `PORT` with value `10000`

11. Click `Create Web Service`.
12. After deploy finishes, open the Render URL.

## 6. Verify it is live

1. Open your Render URL.
2. Confirm records appear.
3. Add or edit a shipment in the dashboard.
4. Refresh the page.
5. Confirm the change remains after refresh.
6. Trigger `POST /api/sync-sheet` once and confirm new sheet rows appear.

## 7. Recommended next step

Add login protection before sharing publicly. Right now this version is open to anyone who can reach the site URL.
