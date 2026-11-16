// Storage, password hashing and published-data sync.
// Everything is kept in the browser's localStorage.

const DB_KEY = "exam_db_v2";
const SESSION_KEY = "exam_session_v2";       // sessionStorage: login ends when the tab closes
const ACTIVE_PREFIX = "exam_active_v2_";     // + userId: exam attempt in progress
const RESULTS_KEY_LS = "exam_results_key_v2";

const DB = {
  data: null,

  load() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(DB_KEY)); } catch (e) { /* ignore */ }
    if (!d || typeof d !== "object") d = {};
    d.users = Array.isArray(d.users) ? d.users : [];
    d.exams = Array.isArray(d.exams) ? d.exams : [];
    d.attempts = Array.isArray(d.attempts) ? d.attempts : [];
    d.publishedVersion = d.publishedVersion || 0;
    d.dirty = !!d.dirty;
    this.data = d;
  },

  save() {
    try {
      localStorage.setItem(DB_KEY, JSON.stringify(this.data));
    } catch (e) {
      alert("Browser storage is full or blocked. Changes could not be saved.");
    }
  },

  uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
};

// ---------- password hashing (PBKDF2-SHA256 via WebCrypto) ----------
function bytesToB64(bytes) {
  let s = "";
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s);
}
function b64ToBytes(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function hashPassword(password, saltB64) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const salt = saltB64 ? b64ToBytes(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    key,
    256
  );
  return { salt: bytesToB64(salt), hash: bytesToB64(new Uint8Array(bits)) };
}

async function verifyPassword(user, password) {
  const { hash } = await hashPassword(password, user.salt);
  return hash === user.hash;
}

// ---------- attempt in progress (survives refresh / closing the browser) ----------
function loadActive(userId) {
  try { return JSON.parse(localStorage.getItem(ACTIVE_PREFIX + userId)); } catch (e) { return null; }
}
function saveActive(userId, obj) {
  try { localStorage.setItem(ACTIVE_PREFIX + userId, JSON.stringify(obj)); } catch (e) { /* ignore */ }
}
function clearActive(userId) {
  localStorage.removeItem(ACTIVE_PREFIX + userId);
}

// ---------- published data (data.json in the repo) ----------
// The admin's browser is the master copy. "Publish" downloads data.json, which the admin
// uploads to the repo. Every other device loads it automatically when its version is newer.
async function syncPublished() {
  try {
    const res = await fetch("data.json?ts=" + Date.now(), { cache: "no-store" });
    if (!res.ok) return;
    const pub = await res.json();
    if (
      pub && Array.isArray(pub.users) && Array.isArray(pub.exams) &&
      Number(pub.version) > DB.data.publishedVersion
    ) {
      DB.data.users = pub.users;
      DB.data.exams = pub.exams;
      DB.data.publishedVersion = Number(pub.version);
      DB.save();
    }
  } catch (e) {
    /* offline, or opened from a file: keep local data */
  }
}
