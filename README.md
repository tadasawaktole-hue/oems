# Online Exam System (GitHub Pages) - Admin / Teacher / Student

A static website with three roles. No server is needed, but that shapes how data is shared, so please read "How data works".

## Roles
| Role | Can do |
|---|---|
| **Admin** | Create/delete teacher and student accounts (one by one or in bulk), reset passwords, import exams from PDF (or pasted text), assign an exam to a teacher, enable/disable/delete exams, view all results, publish data, backup/restore |
| **Teacher** | See the exams assigned to them and view/export the results for those exams |
| **Student** | Sign in, take open exams (timer, auto-submit, progress saved on refresh), see own results |

## First run
1. Open the site **on the administrator's computer** and create the Admin account (shown only when no accounts exist).
2. Create teachers/students in the **Users** tab.
3. Import exams in the **Import exam** tab (see below).
4. Open the **Data** tab and click **Download data.json**, then upload it to your repository, replacing the old `data.json`. Do this after every change to users or exams.

## Importing an exam from PDF
Upload a **text-based** PDF (not a scan) laid out like this, or paste the text:

```
Exam title (optional)

1. Question text
A. Option
B. Option
C. Option
Answer: B
```
Answers can also be listed at the end: `Answer Key: 1-B, 2-A`. See `sample-exam.txt` and `sample-exam.pdf` (a ready-made PDF to test the import).
After parsing, you review the questions, tick the correct answers, set the duration and attempts, and assign a teacher before saving. Reading the PDF happens in the browser using pdf.js loaded from cdnjs, so it needs an internet connection.

## How data works (important)
GitHub Pages only serves files; it has no database.
- **Accounts and exams** are stored in the admin's browser. Publishing writes them to `data.json`; every other device loads it automatically on start.
- **Student results** are stored in the student's browser. To let teachers and the admin see results from **all** students, set up the free Google Sheet below. Without it, each browser only shows its own results.
- **Login session** ends when the browser tab closes. An exam in progress is saved and resumes after refresh or re-login.

## Collect results from all students (Google Sheet)
1. Create a Google Sheet, then Extensions > Apps Script. Paste `apps-script.gs` and change `SECRET`.
2. Deploy > New deployment > Web app > Execute as **Me**, access **Anyone**. Copy the web app URL.
3. Put the URL in `config.js` (`endpoint`), upload to the repo.
4. Teachers/admin open the Results tab and enter the SECRET as the results key.

## Deploy
Create a public repo, upload everything in this folder to the root, then Settings > Pages > Deploy from a branch > `main` / root.

## Security limits (please read)
This is a convenience login for classrooms and practice tests, not a hardened system:
- Everything runs in the browser. A technical student can open developer tools and read the exam answer keys, edit browser storage, or change their own role on their own device.
- `data.json` is public on a public repo. It contains password **hashes** (PBKDF2-SHA256, salted, not plain text) and the answer keys. Use strong passwords.
- Attempts-allowed is enforced per browser only.

For graded or high-stakes exams you need a real backend (for example Firebase or Supabase) so logins, answer keys and results stay on a server. This project can be adapted to one.
