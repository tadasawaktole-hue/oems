# OEMS — Online Examination Management System

A React + Vite app that runs **entirely in the browser**, so it deploys to GitHub Pages with no server, database or API keys.

- Data persists in the browser (`localStorage`), with one-click **backup / restore** (JSON file).
- **Import questions from a PDF** (or pasted text). Parsing happens locally; nothing is uploaded.
- Admin: students, exams, results, school profile, audit log. Students: take timed exams, auto-graded.

## Deploy to GitHub Pages

1. Push this folder to your repository (`main` or `master`).
2. **Settings → Pages → Source: GitHub Actions.**
3. The workflow in `.github/workflows/deploy.yml` builds and publishes automatically. Your site is at `https://<user>.github.io/<repo>/`. The base path is detected from the repository name, so no configuration is needed.

**Remove these old files from the repository** (they belonged to the server version): `server.ts`, `render.yaml`, `backend/`, `.env.example`, and any old workflow in `.github/workflows/`.

## Run locally

    npm install
    npm run dev

## First use

Open the site, create the administrator account (first-time setup), sign in, add students, then create an exam.

## Importing questions from a PDF

Exams → New exam → choose a PDF (or paste text) → **Import questions**. Recognised layout:

    1. Question text
    A. option        (also A) / (A) / a.)
    B. option
    Answer: B        (or an "Answer Key" list at the end: 1-B 2-C ..., or a * after the right option)

Options may also sit on one line (`A. x  B. y  C. z`). Questions with no detected answer are flagged in red and must be set before saving. PDFs must contain real text; scanned images are not OCR'd, so paste the text instead.

## Important limitations

- Data lives in the browser on the device where it was entered; other devices do not see it. Use **Backup → Download backup** regularly, and to move data between computers.
- Without a server this suits classroom and practice exams, **not high-stakes exams**: a technically skilled person using the same browser could inspect stored data.
- Clearing site data in the browser deletes the database, so back up first.
