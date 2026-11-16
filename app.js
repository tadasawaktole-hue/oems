// Role-based online exam: Admin / Teacher / Student.
// See README.md for how data is stored and shared across devices.

const $ = (id) => document.getElementById(id);

let me = null;          // logged-in user
let tab = null;         // current tab id
let draft = null;       // exam being imported (admin)
let flash = null;       // one-time message shown after an action
let timerInterval = null;
let toastTimer = null;

const FORMAT_HELP = `Final Exam Title (optional first line)

1. What does HTML stand for?
A. Hyper Text Markup Language
B. High Tech Modern Language
C. Home Tool Markup Language
Answer: A

2. Which GitHub feature hosts static websites for free?
A. GitHub Actions
B. GitHub Pages
C. GitHub Copilot
Answer: B

(Or list all answers at the end:  Answer Key: 1-A, 2-B )`;

// ---------- small helpers ----------
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = !!v;
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function notify(msg, bad) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show" + (bad ? " bad" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = "toast"), 5000);
}

function field(label, input) {
  return h("label", { class: "field" }, label, input);
}

function table(headers, rows) {
  return h("table", {},
    h("thead", {}, h("tr", {}, headers.map((x) => h("th", {}, x)))),
    h("tbody", {}, rows.map((r) => h("tr", {}, r.map((c) => h("td", {}, c)))))
  );
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(v) {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s; // block spreadsheet formula injection
  return '"' + s.replace(/"/g, '""') + '"';
}

function currentUser() {
  let id = null;
  try { id = sessionStorage.getItem(SESSION_KEY); } catch (e) { /* ignore */ }
  return id ? DB.data.users.find((u) => u.id === id) || null : null;
}

function logout() {
  sessionStorage.removeItem(SESSION_KEY);
  tab = null;
  draft = null;
  render();
}

function markDirty() {
  DB.data.dirty = true;
  DB.save();
}

// ---------- accounts ----------
async function createUser(name, username, password, role) {
  name = String(name || "").trim();
  username = String(username || "").trim();
  if (!name || !username) throw new Error("Name and username are required.");
  if (!/^[A-Za-z0-9._@-]{3,40}$/.test(username))
    throw new Error("Username must be 3-40 characters: letters, numbers . _ @ -");
  if (String(password || "").length < 6) throw new Error("Password must be at least 6 characters.");
  if (DB.data.users.some((u) => u.username.toLowerCase() === username.toLowerCase()))
    throw new Error('Username "' + username + '" already exists.');
  const { salt, hash } = await hashPassword(password);
  const user = { id: DB.uid(), name, username, role, salt, hash };
  DB.data.users.push(user);
  markDirty();
  return user;
}

// ---------- PDF import ----------
async function extractPdfText(file) {
  const buf = await file.arrayBuffer();
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let out = "";
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    let lastY = null;
    let line = "";
    for (const it of content.items) {
      const y = it.transform[5];
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        out += line + "\n";
        line = "";
      }
      line += it.str;
      lastY = y;
    }
    out += line + "\n";
  }
  return out;
}

function startDraft(text, fallbackTitle) {
  const r = parseExamText(text);
  draft = {
    title: r.title || fallbackTitle || "",
    durationMinutes: 30,
    teacherId: "",
    attemptsAllowed: 1,
    questions: r.questions,
    warnings: r.warnings
  };
  if (!r.questions.length) notify("No questions detected. Check the format below.", true);
  render();
}

async function onPdfChosen(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (typeof pdfjsLib === "undefined") return notify("PDF reader did not load. Check your internet connection.", true);
  notify("Reading PDF...");
  try {
    const text = await extractPdfText(file);
    if (text.trim().length < 10)
      return notify("No text found. Scanned/image PDFs are not supported; paste the text instead.", true);
    startDraft(text, file.name.replace(/\.pdf$/i, ""));
  } catch (err) {
    console.error(err);
    notify("Could not read this PDF.", true);
  }
}

function saveDraft() {
  const d = draft;
  if (!d.title.trim()) return notify("Give the exam a title.", true);
  const dur = Number(d.durationMinutes);
  if (!(dur >= 1 && dur <= 600)) return notify("Duration must be 1-600 minutes.", true);
  if (!d.questions.length) return notify("The exam has no questions.", true);

  const questions = [];
  for (let i = 0; i < d.questions.length; i++) {
    const q = d.questions[i];
    if (!q.q.trim()) return notify("Question " + (i + 1) + " has no text.", true);
    const options = [];
    let answer = null;
    q.options.forEach((o, oi) => {
      if (o.trim()) {
        if (q.answer === oi) answer = options.length;
        options.push(o.trim());
      }
    });
    if (options.length < 2) return notify("Question " + (i + 1) + " needs at least 2 options.", true);
    if (answer === null) return notify("Question " + (i + 1) + ": select the correct answer.", true);
    questions.push({ q: q.q.trim(), options, answer });
  }

  DB.data.exams.push({
    id: DB.uid(),
    title: d.title.trim(),
    durationMinutes: dur,
    teacherId: d.teacherId || "",
    attemptsAllowed: Math.max(1, Number(d.attemptsAllowed) || 1),
    active: true,
    createdAt: new Date().toISOString(),
    questions
  });
  markDirty();
  draft = null;
  tab = "exams";
  flash = "Exam saved. Open the Data tab and publish so students on other devices can see it.";
  render();
}

// ---------- taking an exam ----------
function startAttempt(exam) {
  if (!confirm('Start "' + exam.title + '"? The timer begins now (' + exam.durationMinutes + " minutes).")) return;
  const now = Date.now();
  saveActive(me.id, {
    examId: exam.id,
    startedAt: now,
    endsAt: now + exam.durationMinutes * 60000,
    answers: {},
    tabSwitches: 0
  });
  render();
}

let submitting = false;
function submitAttempt(active, exam, auto) {
  if (submitting) return;
  submitting = true;
  clearInterval(timerInterval);

  let score = 0;
  exam.questions.forEach((q, i) => {
    if (active.answers[i] === q.answer) score++;
  });
  const attempt = {
    id: DB.uid(),
    examId: exam.id,
    examTitle: exam.title,
    studentId: me.id,
    studentName: me.name,
    username: me.username,
    score,
    total: exam.questions.length,
    percent: Math.round((score / exam.questions.length) * 100),
    submittedAt: new Date().toISOString(),
    tabSwitches: active.tabSwitches || 0,
    autoSubmitted: !!auto
  };
  DB.data.attempts.push(attempt);
  DB.save();
  clearActive(me.id);
  sendAttempt(attempt);

  flash =
    "Submitted" + (auto ? " (time expired)" : "") + ". You scored " + score + " out of " +
    attempt.total + " (" + attempt.percent + "%).";
  tab = "mine";
  submitting = false;
  render();
}

function sendAttempt(attempt) {
  if (!APP_CONFIG.endpoint) return;
  // no-cors: the request is sent even though the reply cannot be read
  fetch(APP_CONFIG.endpoint, {
    method: "POST",
    mode: "no-cors",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(attempt)
  }).catch(() => { /* result is still stored locally */ });
}

async function loadAllAttempts() {
  let rows = DB.data.attempts.slice();
  let remoteErr = null;
  if (APP_CONFIG.endpoint) {
    const key = localStorage.getItem(RESULTS_KEY_LS);
    if (!key) {
      remoteErr = "Enter the results key to load results from the server.";
    } else {
      try {
        const r = await fetch(APP_CONFIG.endpoint + "?key=" + encodeURIComponent(key));
        const j = await r.json();
        if (Array.isArray(j)) rows = rows.concat(j);
        else remoteErr = "The server rejected the results key.";
      } catch (e) {
        remoteErr = "Could not reach the results server.";
      }
    }
  }
  const seen = new Map();
  rows.forEach((r) => seen.set(String(r.id), r));
  return { rows: [...seen.values()], remoteErr };
}

// ---------- views: setup & login ----------
function viewSetup() {
  const f = h("form", {
    class: "card narrow",
    onsubmit: async (e) => {
      e.preventDefault();
      if (f.password.value !== f.confirm.value) return notify("Passwords do not match.", true);
      try {
        const u = await createUser(f.fullname.value, f.username.value, f.password.value, "admin");
        sessionStorage.setItem(SESSION_KEY, u.id);
        tab = null;
        render();
      } catch (err) {
        notify(err.message, true);
      }
    }
  },
    h("h1", {}, "First-time setup"),
    h("p", { class: "muted" }, "Create the Admin account. Do this only on the administrator's own computer, and only once."),
    field("Full name", h("input", { type: "text", name: "fullname", required: true })),
    field("Username", h("input", { type: "text", name: "username", required: true, autocomplete: "off" })),
    field("Password (min 6 characters)", h("input", { type: "password", name: "password", required: true })),
    field("Confirm password", h("input", { type: "password", name: "confirm", required: true })),
    h("button", {}, "Create admin account")
  );
  return f;
}

function viewLogin() {
  const f = h("form", {
    class: "card narrow",
    onsubmit: async (e) => {
      e.preventDefault();
      const username = f.username.value.trim().toLowerCase();
      const user = DB.data.users.find((u) => u.username.toLowerCase() === username);
      if (!user)
        return notify(
          'No account "' + f.username.value.trim() + '" on this device. If the admin just created it, ' +
          "the updated data.json must be uploaded to the repository first. Then press \"Reload accounts\" below.",
          true
        );
      if (!(await verifyPassword(user, f.password.value)))
        return notify("Wrong password for this account.", true);
      sessionStorage.setItem(SESSION_KEY, user.id);
      tab = null;
      render();
    }
  },
    h("h1", {}, "Online Exam"),
    h("p", { class: "muted" }, "Sign in to continue."),
    field("Username", h("input", { type: "text", name: "username", required: true, autocomplete: "username" })),
    field("Password", h("input", { type: "password", name: "password", required: true, autocomplete: "current-password" })),
    h("button", {}, "Sign in"),
    h("hr"),
    h("p", { class: "muted small" },
      DB.data.publishedVersion
        ? "Accounts loaded from data.json published " + new Date(DB.data.publishedVersion).toLocaleString()
        : "No published accounts loaded on this device yet."),
    h("button", {
      type: "button",
      class: "secondary",
      onclick: async () => {
        await syncPublished();
        notify("Accounts reloaded.");
        render();
      }
    }, "Reload accounts")
  );
  return f;
}

// ---------- views: admin ----------
function viewUsers() {
  const roleSel = () => h("select", { name: "role" },
    h("option", { value: "student" }, "Student"),
    h("option", { value: "teacher" }, "Teacher"));

  const f = h("form", {
    class: "grid",
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        await createUser(f.fullname.value, f.username.value, f.password.value, f.role.value);
        flash = "Account created.";
        render();
      } catch (err) {
        notify(err.message, true);
      }
    }
  },
    field("Full name", h("input", { type: "text", name: "fullname", required: true })),
    field("Username", h("input", { type: "text", name: "username", required: true, autocomplete: "off" })),
    field("Password", h("input", { type: "text", name: "password", required: true, autocomplete: "off", placeholder: "min 6 chars" })),
    field("Role", roleSel()),
    h("button", {}, "Create account")
  );

  const bulkRole = roleSel();
  const bulkText = h("textarea", { placeholder: "Full name, username, password\nJane Doe, jane.doe, secret123" });
  const bulk = h("div", {},
    h("h3", {}, "Add many accounts at once"),
    h("p", { class: "muted small" }, "One per line: full name, username, password."),
    bulkText,
    h("div", { class: "row" }, bulkRole,
      h("button", {
        onclick: async () => {
          const lines = bulkText.value.split("\n").map((l) => l.trim()).filter(Boolean);
          let ok = 0;
          const errs = [];
          for (const line of lines) {
            const p = line.split(",").map((x) => x.trim());
            try {
              if (p.length < 3) throw new Error("expected 3 values");
              await createUser(p[0], p[1], p.slice(2).join(","), bulkRole.value);
              ok++;
            } catch (err) {
              errs.push(line.split(",")[0] + ": " + err.message);
            }
          }
          flash = ok + " account(s) created." + (errs.length ? " Problems: " + errs.join("; ") : "");
          render();
        }
      }, "Create accounts"))
  );

  const users = DB.data.users.slice().sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name));
  const rows = users.map((u) => [
    u.name,
    u.username,
    h("span", { class: "badge " + u.role }, u.role),
    h("span", {},
      h("button", {
        class: "secondary",
        onclick: async () => {
          const pw = prompt("New password for " + u.username + " (min 6 characters):");
          if (pw === null) return;
          if (pw.length < 6) return notify("Password must be at least 6 characters.", true);
          const { salt, hash } = await hashPassword(pw);
          u.salt = salt;
          u.hash = hash;
          markDirty();
          notify("Password changed.");
        }
      }, "Reset password"),
      u.id === me.id ? null : h("button", {
        class: "danger",
        onclick: () => {
          if (!confirm("Delete " + u.name + " (" + u.username + ")?")) return;
          DB.data.users = DB.data.users.filter((x) => x.id !== u.id);
          localStorage.removeItem(ACTIVE_PREFIX + u.id);
          markDirty();
          render();
        }
      }, "Delete"))
  ]);

  return h("div", {},
    h("h3", {}, "Create an account"), f,
    h("div", { class: "table-wrap" }, table(["Name", "Username", "Role", "Actions"], rows)),
    bulk);
}

function viewExams() {
  const isAdmin = me.role === "admin";
  const exams = DB.data.exams.filter((e) => isAdmin || e.teacherId === me.id);
  if (!exams.length)
    return h("p", { class: "muted" }, isAdmin ? "No exams yet. Use the Import exam tab." : "No exams are assigned to you yet.");
  const teachers = DB.data.users.filter((u) => u.role === "teacher");

  const rows = exams.map((e) => {
    const teacherCell = isAdmin
      ? (() => {
          const s = h("select", {
            onchange: () => { e.teacherId = s.value; markDirty(); notify("Teacher updated."); }
          }, h("option", { value: "" }, "-- none --"),
            teachers.map((t) => h("option", { value: t.id }, t.name)));
          s.value = e.teacherId || "";
          return s;
        })()
      : (DB.data.users.find((u) => u.id === e.teacherId) || {}).name || "";
    return [
      e.title,
      e.questions.length,
      e.durationMinutes + " min",
      e.attemptsAllowed || 1,
      teacherCell,
      h("span", { class: "badge" }, e.active === false ? "disabled" : "open"),
      isAdmin ? h("span", {},
        h("button", {
          class: "secondary",
          onclick: () => { e.active = e.active === false; markDirty(); render(); }
        }, e.active === false ? "Enable" : "Disable"),
        h("button", {
          class: "danger",
          onclick: () => {
            if (!confirm('Delete exam "' + e.title + '"?')) return;
            DB.data.exams = DB.data.exams.filter((x) => x.id !== e.id);
            markDirty();
            render();
          }
        }, "Delete")) : ""
    ];
  });
  return h("div", { class: "table-wrap" },
    table(["Title", "Questions", "Duration", "Attempts", "Teacher", "Status", isAdmin ? "Actions" : ""], rows));
}

function viewImport() {
  const pasteBox = h("textarea", { placeholder: "Paste exam text here (same format as below)" });
  const wrap = h("div", {},
    h("p", { class: "muted" }, "Upload a text-based PDF or paste the exam text. You can review and fix everything before saving."),
    h("div", { class: "row" },
      h("input", { type: "file", accept: ".pdf,application/pdf", onchange: onPdfChosen })),
    h("details", {},
      h("summary", {}, "Or paste text instead"),
      pasteBox,
      h("button", {
        class: "secondary",
        onclick: () => {
          if (pasteBox.value.trim().length < 10) return notify("Paste some exam text first.", true);
          startDraft(pasteBox.value, "");
        }
      }, "Parse text")),
    h("details", {}, h("summary", {}, "Expected format"), h("pre", {}, FORMAT_HELP)));
  if (draft) wrap.append(viewDraft());
  return wrap;
}

function viewDraft() {
  const d = draft;
  const teachers = DB.data.users.filter((u) => u.role === "teacher");
  const teacherSel = h("select", { onchange: () => (d.teacherId = teacherSel.value) },
    h("option", { value: "" }, "-- none --"),
    teachers.map((t) => h("option", { value: t.id }, t.name)));
  teacherSel.value = d.teacherId || "";

  const meta = h("div", { class: "grid" },
    field("Exam title", h("input", { type: "text", value: d.title, oninput: (e) => (d.title = e.target.value) })),
    field("Duration (minutes)", h("input", { type: "number", min: 1, value: d.durationMinutes, oninput: (e) => (d.durationMinutes = e.target.value) })),
    field("Attempts allowed", h("input", { type: "number", min: 1, value: d.attemptsAllowed, oninput: (e) => (d.attemptsAllowed = e.target.value) })),
    field("Teacher", teacherSel));

  const cards = d.questions.map((q, qi) =>
    h("div", { class: "q-card" },
      h("strong", {}, "Question " + (qi + 1)),
      h("textarea", { oninput: (e) => (q.q = e.target.value) }, q.q),
      q.options.map((o, oi) =>
        h("div", { class: "opt-row" },
          h("input", { type: "radio", name: "correct" + qi, checked: q.answer === oi, onchange: () => (q.answer = oi), title: "Correct answer" }),
          h("input", { type: "text", value: o, oninput: (e) => (q.options[oi] = e.target.value) }))),
      h("button", { class: "secondary", onclick: () => { q.options.push(""); render(); } }, "+ Option"),
      h("button", { class: "danger", onclick: () => { d.questions.splice(qi, 1); render(); } }, "Remove question"),
      q.answer === null ? h("span", { class: "badge" }, "pick the correct answer") : null));

  return h("div", {},
    h("hr"),
    h("h3", {}, "Review imported exam (" + d.questions.length + " questions)"),
    d.warnings.length
      ? h("div", { class: "notice warn" }, h("strong", {}, "Check these: "), h("ul", {}, d.warnings.map((w) => h("li", {}, w))))
      : null,
    meta,
    h("p", { class: "muted small" }, "Select the radio button next to each correct answer. Empty options are dropped on save."),
    cards,
    h("button", { class: "secondary", onclick: () => { d.questions.push({ q: "", options: ["", "", "", ""], answer: null }); render(); } }, "+ Add question"),
    h("button", { onclick: saveDraft }, "Save exam"),
    h("button", { class: "secondary", onclick: () => { draft = null; render(); } }, "Discard"));
}

function viewData() {
  const keyIn = h("input", { type: "password", value: localStorage.getItem(RESULTS_KEY_LS) || "", placeholder: "Results key" });
  const backupIn = h("input", {
    type: "file",
    accept: ".json,application/json",
    onchange: async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const b = JSON.parse(await file.text());
        if (!Array.isArray(b.users) || !Array.isArray(b.exams)) throw new Error("bad file");
        if (!confirm("Replace ALL data in this browser with the backup?")) return;
        DB.data.users = b.users;
        DB.data.exams = b.exams;
        DB.data.attempts = Array.isArray(b.attempts) ? b.attempts : [];
        DB.data.publishedVersion = b.publishedVersion || 0;
        DB.data.dirty = true;
        DB.save();
        if (!currentUser()) return logout();
        flash = "Backup restored.";
        render();
      } catch (err) {
        notify("That is not a valid backup file.", true);
      }
    }
  });

  return h("div", {},
    h("h3", {}, "Publish accounts and exams"),
    h("p", {}, "Other devices get accounts and exams from data.json in your GitHub repository. After changing users or exams, download it and upload it to the repo (replace the old data.json)."),
    h("div", { class: "notice warn small" }, "data.json is public on a public repository. It holds password hashes (not plain passwords) and the exam answer keys, so use strong passwords."),
    h("button", {
      onclick: () => {
        const version = Date.now();
        download("data.json", JSON.stringify({ version, users: DB.data.users, exams: DB.data.exams }, null, 2), "application/json");
        DB.data.publishedVersion = version;
        DB.data.dirty = false;
        DB.save();
        flash = "data.json downloaded. Upload it to your GitHub repository to publish.";
        render();
      }
    }, "Download data.json"),
    h("hr"),
    h("h3", {}, "Backup and restore (this browser)"),
    h("p", { class: "muted" }, "Includes users, exams and results stored here."),
    h("button", {
      class: "secondary",
      onclick: () => download("exam-backup-" + new Date().toISOString().slice(0, 10) + ".json", JSON.stringify(DB.data, null, 2), "application/json")
    }, "Download backup"),
    h("div", {}, h("label", { class: "small muted" }, "Restore from backup: "), backupIn),
    APP_CONFIG.endpoint ? h("div", {},
      h("hr"),
      h("h3", {}, "Results server key"),
      h("div", { class: "row" }, keyIn,
        h("button", { onclick: () => { localStorage.setItem(RESULTS_KEY_LS, keyIn.value.trim()); notify("Key saved in this browser."); } }, "Save key"))) : null);
}

// ---------- views: results (admin & teacher) ----------
function viewResults() {
  const box = h("div", {}, h("p", { class: "muted" }, "Loading results..."));
  loadAllAttempts().then(({ rows, remoteErr }) => box.replaceChildren(buildResults(rows, remoteErr)));
  return box;
}

function buildResults(all, remoteErr) {
  const isAdmin = me.role === "admin";
  const myExams = DB.data.exams.filter((e) => isAdmin || e.teacherId === me.id);
  const myIds = new Set(myExams.map((e) => e.id));
  const rows = isAdmin ? all : all.filter((r) => myIds.has(r.examId));

  let current = [];
  const sel = h("select", { onchange: () => draw() },
    h("option", { value: "" }, "All exams"),
    myExams.map((e) => h("option", { value: e.id }, e.title)));
  const tableBox = h("div", { class: "table-wrap" });

  const draw = () => {
    current = rows
      .filter((r) => !sel.value || r.examId === sel.value)
      .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
    tableBox.replaceChildren(
      current.length
        ? table(["Date", "Student", "Username", "Exam", "Score", "%", "Tab switches"],
            current.map((r) => [
              new Date(r.submittedAt).toLocaleString(), r.studentName, r.username, r.examTitle,
              r.score + "/" + r.total, r.percent + "%", r.tabSwitches
            ]))
        : h("p", { class: "muted" }, "No results yet."));
  };

  const bar = h("div", { class: "row" }, sel,
    h("button", {
      onclick: () => {
        const head = ["Submitted", "Student", "Username", "Exam", "Score", "Total", "Percent", "Tab switches", "Auto-submitted"];
        const lines = [head].concat(current.map((r) =>
          [r.submittedAt, r.studentName, r.username, r.examTitle, r.score, r.total, r.percent, r.tabSwitches, r.autoSubmitted]));
        download("results.csv", lines.map((l) => l.map(csvCell).join(",")).join("\n"), "text/csv");
      }
    }, "Download CSV"),
    h("button", { class: "secondary", onclick: () => render() }, "Refresh"));

  const out = h("div", {});
  if (!APP_CONFIG.endpoint) {
    out.append(h("div", { class: "notice small" },
      "Showing results stored in this browser only. To collect results from all students' devices, set up the results server (see README)."));
  } else {
    const keyIn = h("input", { type: "password", value: localStorage.getItem(RESULTS_KEY_LS) || "", placeholder: "Results key" });
    out.append(h("div", { class: "row" }, keyIn,
      h("button", { class: "secondary", onclick: () => { localStorage.setItem(RESULTS_KEY_LS, keyIn.value.trim()); render(); } }, "Load from server")));
  }
  if (remoteErr) out.append(h("div", { class: "notice warn small" }, remoteErr));
  out.append(bar, tableBox);
  draw();
  return out;
}

// ---------- views: student ----------
function viewAvailable() {
  const exams = DB.data.exams.filter((e) => e.active !== false);
  if (!exams.length) return h("p", { class: "muted" }, "No exams are available yet.");
  return h("div", {}, exams.map((e) => {
    const allowed = e.attemptsAllowed || 1;
    const used = DB.data.attempts.filter((a) => a.studentId === me.id && a.examId === e.id).length;
    return h("div", { class: "card" },
      h("h3", {}, e.title),
      h("p", { class: "muted" }, e.questions.length + " questions · " + e.durationMinutes + " min · attempts used " + used + "/" + allowed),
      h("button", { disabled: used >= allowed, onclick: () => startAttempt(e) }, used >= allowed ? "No attempts left" : "Start exam"));
  }));
}

function viewMyResults() {
  const mine = DB.data.attempts
    .filter((a) => a.studentId === me.id)
    .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
  if (!mine.length) return h("p", { class: "muted" }, "You have not taken any exams yet.");
  return h("div", { class: "table-wrap" },
    table(["Date", "Exam", "Score", "%"],
      mine.map((a) => [new Date(a.submittedAt).toLocaleString(), a.examTitle, a.score + "/" + a.total, a.percent + "%"])));
}

function viewExam(active) {
  const exam = DB.data.exams.find((e) => e.id === active.examId);
  if (!exam) {
    clearActive(me.id);
    return null;
  }
  const timer = h("span", {}, "Time left: --:--");
  const tick = () => {
    const rem = Math.max(0, Math.round((active.endsAt - Date.now()) / 1000));
    timer.textContent = "Time left: " + String(Math.floor(rem / 60)).padStart(2, "0") + ":" + String(rem % 60).padStart(2, "0");
    timer.className = rem <= 30 ? "low" : "";
    if (rem <= 0) submitAttempt(active, exam, true);
  };

  const blocks = exam.questions.map((q, qi) =>
    h("div", { class: "question-block" },
      h("p", {}, h("strong", {}, (qi + 1) + ". " + q.q)),
      q.options.map((o, oi) =>
        h("label", { class: "opt" },
          h("input", {
            type: "radio",
            name: "q" + qi,
            checked: active.answers[qi] === oi,
            onchange: () => { active.answers[qi] = oi; saveActive(me.id, active); }
          }),
          h("span", {}, o)))));

  const view = h("div", { class: "card" },
    h("div", { class: "exam-top" }, h("span", {}, exam.title + " — " + me.name), timer),
    blocks,
    h("button", { onclick: () => { if (confirm("Submit your exam now?")) submitAttempt(active, exam, false); } }, "Submit exam"),
    h("p", { class: "muted small" }, "Answers and the timer are saved automatically. Refreshing the page will not reset your progress."));

  setTimeout(tick, 0);
  timerInterval = setInterval(tick, 1000);
  return view;
}

// ---------- shell & router ----------
function tabsFor(role) {
  if (role === "admin")
    return [
      { id: "users", label: "Users" }, { id: "exams", label: "Exams" }, { id: "import", label: "Import exam" },
      { id: "results", label: "Results" }, { id: "data", label: "Data" }
    ];
  if (role === "teacher") return [{ id: "exams", label: "My exams" }, { id: "results", label: "Results" }];
  return [{ id: "available", label: "Exams" }, { id: "mine", label: "My results" }];
}

function shell() {
  const tabs = tabsFor(me.role);
  if (!tab || !tabs.some((t) => t.id === tab)) tab = tabs[0].id;
  const views = {
    users: viewUsers, exams: viewExams, import: viewImport, results: viewResults,
    data: viewData, available: viewAvailable, mine: viewMyResults
  };
  const msg = flash;
  flash = null;
  return h("div", {},
    h("div", { class: "topbar" },
      h("strong", {}, "Online Exam"),
      h("span", { class: "muted" }, me.name + " ", h("span", { class: "badge " + me.role }, me.role)),
      h("button", { class: "secondary", onclick: logout }, "Log out")),
    h("div", { class: "tabs" }, tabs.map((t) =>
      h("button", { class: "tab" + (t.id === tab ? " active" : ""), onclick: () => { tab = t.id; render(); } }, t.label))),
    h("div", { class: "panel" },
      me.role === "admin" && DB.data.dirty
        ? h("div", { class: "notice warn small" }, "You have unpublished changes. Open the Data tab and download data.json so other devices get them.")
        : null,
      msg ? h("div", { class: "notice" }, msg) : null,
      views[tab]()));
}

function render() {
  clearInterval(timerInterval);
  const app = $("app");
  app.replaceChildren();
  if (!DB.data.users.length) return app.append(viewSetup());
  me = currentUser();
  if (!me) return app.append(viewLogin());
  if (me.role === "student") {
    const active = loadActive(me.id);
    if (active) {
      const v = viewExam(active);
      if (v) return app.append(v);
    }
  }
  app.append(shell());
}

// count tab switches during an exam (saved with the attempt)
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) return;
  const u = currentUser();
  if (!u || u.role !== "student") return;
  const a = loadActive(u.id);
  if (a) {
    a.tabSwitches = (a.tabSwitches || 0) + 1;
    saveActive(u.id, a);
  }
});

async function init() {
  DB.load();
  if (!window.crypto || !crypto.subtle) {
    $("app").textContent = "This app needs a secure page (https). Open it from your GitHub Pages address.";
    return;
  }
  await syncPublished();
  render();
}

init();
