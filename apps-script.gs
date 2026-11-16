// Google Apps Script backend for collecting results from all students.
// Paste into Extensions > Apps Script of a Google Sheet, change SECRET, then
// Deploy > New deployment > Web app > Execute as: Me, Who has access: Anyone.

const SECRET = "CHANGE_ME_TO_A_LONG_RANDOM_STRING"; // teachers/admin enter this as the "results key"
const HEADERS = ["id", "examId", "examTitle", "studentId", "studentName", "username",
  "score", "total", "percent", "submittedAt", "tabSwitches", "autoSubmitted"];

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName("Results");
  if (!sh) {
    sh = ss.insertSheet("Results");
    sh.appendRow(HEADERS);
  }
  return sh;
}

function safe_(v) {
  // stop spreadsheet formula injection
  if (typeof v === "string" && /^[=+\-@]/.test(v)) return "'" + v;
  return v;
}

// Students' browsers POST their result here.
function doPost(e) {
  const d = JSON.parse(e.postData.contents);
  sheet_().appendRow(HEADERS.map((h) => safe_(d[h])));
  return ContentService.createTextOutput("ok");
}

// Teachers/admin load all results (needs the secret key).
function doGet(e) {
  const out = (obj) =>
    ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
  if (!e.parameter.key || e.parameter.key !== SECRET) return out({ error: "unauthorized" });
  const rows = sheet_().getDataRange().getValues();
  const head = rows.shift();
  return out(rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]]))));
}
