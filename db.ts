/**
 * Browser-side database for OEMS.
 *
 * Everything is stored in window.localStorage under one key, so data survives
 * page reloads, browser restarts and GitHub Pages redeploys (the site's origin
 * does not change when you redeploy). `api()` mimics the REST routes the UI
 * used to call, so the rest of the app does not need to know there is no server.
 */
import type { OEMSData } from './types';

const DB_KEY = 'oems_data_v2';
const SESSION_KEY = 'oems_session_v2';

type Row = Record<string, any>;

interface DB {
  admin: { username: string; fullName: string; hash: string } | null;
  school: Row;
  students: Row[];
  exams: Row[];
  attempts: Row[];
  auditLogs: Row[];
}

export interface ApiResult {
  success: boolean;
  error?: string;
  [key: string]: any;
}

/* ------------------------------------------------------------ hashing -- */
const enc = new TextEncoder();
const toHex = (buf: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(buf as ArrayBuffer), (b) => b.toString(16).padStart(2, '0')).join('');

function fallbackHash(text: string): string {
  // Only used when WebCrypto is unavailable (e.g. page opened over plain http on a LAN address).
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

async function hashPassword(password: string, saltHex?: string): Promise<string> {
  const salt = saltHex || toHex(crypto.getRandomValues(new Uint8Array(16)));
  const subtle = (globalThis.crypto && globalThis.crypto.subtle) || null;
  if (subtle) {
    const key = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await subtle.deriveBits(
      { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
      key,
      256,
    );
    return `pbkdf2$${salt}$${toHex(bits)}`;
  }
  return `fb$${salt}$${fallbackHash(salt + password)}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3) return false;
  const [scheme, salt] = parts;
  if (scheme === 'fb') return `fb$${salt}$${fallbackHash(salt + password)}` === stored;
  return (await hashPassword(password, salt)) === stored;
}

/* ------------------------------------------------------------ storage -- */
const defaultDB = (): DB => ({
  admin: null,
  school: {
    name: 'Online Examination Management System', motto: '', academicYear: '', term: '',
    address: '', contactEmail: '', contactPhone: '',
  },
  students: [], exams: [], attempts: [], auditLogs: [],
});

let memoryFallback: DB | null = null; // used only if localStorage is blocked (private mode etc.)
export let storageWarning = '';

function load(): DB {
  try {
    const raw = window.localStorage.getItem(DB_KEY);
    if (!raw) return memoryFallback || defaultDB();
    const parsed = JSON.parse(raw);
    return { ...defaultDB(), ...parsed };
  } catch {
    return memoryFallback || defaultDB();
  }
}

function save(db: DB): void {
  memoryFallback = db;
  try {
    window.localStorage.setItem(DB_KEY, JSON.stringify(db));
    storageWarning = '';
  } catch {
    storageWarning =
      'This browser is blocking or has run out of storage, so changes will be lost when you close the tab. Export a backup from the Backup tab.';
  }
}

export async function requestPersistentStorage(): Promise<void> {
  try {
    await (navigator as any).storage?.persist?.();
  } catch {
    /* optional hardening only */
  }
}

/* ------------------------------------------------------------ session -- */
interface Session { role: 'admin' | 'student'; userId: string; fullName: string }

export function getSession(): Session | null {
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}
const setSession = (s: Session | null) => {
  try {
    if (s) window.localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else window.localStorage.removeItem(SESSION_KEY);
  } catch { /* ignore */ }
};
export const clearSession = () => setSession(null);

/** Public view of a session user (what the UI stores in state). */
export function currentUser(): any | null {
  const s = getSession();
  if (!s) return null;
  const db = load();
  if (s.role === 'admin') return db.admin ? { fullName: db.admin.fullName, role: 'admin' } : null;
  const st = db.students.find((x) => x.id === s.userId && x.status === 'active');
  return st ? { id: st.id, fullName: st.fullName, role: 'student', student: publicStudent(st) } : null;
}

/* ------------------------------------------------------------ helpers -- */
const publicStudent = ({ passwordHash, ...rest }: Row) => rest;
const uid = (p: string) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const nowISO = () => new Date().toISOString();
const ok = (extra: Row = {}): ApiResult => ({ success: true, ...extra });
const fail = (error: string): ApiResult => ({ success: false, error });
const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

function audit(db: DB, actor: string, action: string, details: string) {
  db.auditLogs.unshift({ id: uid('log'), timestamp: nowISO(), actor, action, details });
  if (db.auditLogs.length > 500) db.auditLogs.length = 500;
}

function publicData(db: DB): OEMSData {
  return {
    school: db.school,
    students: db.students.map(publicStudent),
    exams: db.exams as any,
    attempts: db.attempts,
    auditLogs: db.auditLogs,
  };
}

function examOpenError(exam: Row): string | null {
  const today = new Date();
  const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const hm = `${String(today.getHours()).padStart(2, '0')}:${String(today.getMinutes()).padStart(2, '0')}`;
  if (exam.date && ymd < exam.date) return `This exam opens on ${exam.date}.`;
  if (exam.date && ymd === exam.date) {
    if (exam.startTime && hm < exam.startTime) return `This exam opens today at ${exam.startTime}.`;
    if (exam.closingTime && hm > exam.closingTime) return `This exam closed today at ${exam.closingTime}.`;
  }
  return null;
}

function grade(exam: Row, answers: Record<string, string>) {
  let score = 0;
  const total = (exam.questions || []).reduce((s: number, q: Row) => s + (Number(q.marks) || 0), 0);
  for (const q of exam.questions || []) {
    const given = norm(answers[q.id]);
    if (given && given === norm(q.correctAnswer)) score += Number(q.marks) || 0;
  }
  const percentage = total ? Math.round((score / total) * 100) : 0;
  return { score, total, percentage, passed: score >= (Number(exam.passMarks) || 0) };
}

/* ---------------------------------------------------------------- api -- */
export async function api(method: string, path: string, body: any = {}): Promise<ApiResult> {
  try {
    return await route(method.toUpperCase(), path, body || {});
  } catch (e: any) {
    return fail(e?.message || 'Unexpected error.');
  }
}

async function route(method: string, path: string, body: any): Promise<ApiResult> {
  const db = load();
  let m: RegExpMatchArray | null;

  /* ---- public routes ---- */
  if (method === 'GET' && path === '/setup-status') return ok({ needsSetup: !db.admin, school: db.school });

  if (method === 'POST' && path === '/setup') {
    if (db.admin) return fail('An administrator already exists.');
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (username.length < 3) return fail('Username must be at least 3 characters.');
    if (password.length < 8) return fail('Password must be at least 8 characters.');
    db.admin = { username, fullName: String(body.fullName || '').trim() || 'Administrator', hash: await hashPassword(password) };
    if (body.schoolName) db.school.name = String(body.schoolName).trim();
    audit(db, username, 'SETUP', 'Administrator account created');
    save(db);
    return ok();
  }

  if (method === 'POST' && (m = path.match(/^\/login\/(admin|student)$/))) {
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (m[1] === 'admin') {
      if (!db.admin) return fail('No administrator exists yet. Create one first.');
      if (norm(username) === norm(db.admin.username) && (await verifyPassword(password, db.admin.hash))) {
        setSession({ role: 'admin', userId: 'admin', fullName: db.admin.fullName });
        audit(db, db.admin.username, 'LOGIN', 'Administrator signed in');
        save(db);
        return ok({ user: { fullName: db.admin.fullName, role: 'admin' } });
      }
    } else {
      const st = db.students.find((s) => norm(s.username) === norm(username) || norm(s.studentId) === norm(username));
      if (st && (await verifyPassword(password, st.passwordHash))) {
        if (st.status !== 'active') return fail('This account is deactivated. Contact your administrator.');
        setSession({ role: 'student', userId: st.id, fullName: st.fullName });
        return ok({ user: { id: st.id, fullName: st.fullName, role: 'student', student: publicStudent(st) } });
      }
    }
    return fail('Invalid username or password.');
  }

  /* ---- everything below needs a session ---- */
  const session = getSession();
  if (!session) return fail('Please sign in again (session expired).');
  const isAdmin = session.role === 'admin';
  const requireAdmin = () => (isAdmin ? null : fail('Administrator access required.'));
  const actor = isAdmin ? db.admin?.username || 'admin' : session.fullName;

  if (method === 'GET' && path === '/bootstrap') {
    if (!isAdmin) {
      // Students never receive other students' records, hashes or answer keys.
      const me = db.students.find((s) => s.id === session.userId);
      if (!me) return fail('Please sign in again (account not found).');
      const exams = db.exams
        .filter((e) => e.status === 'active')
        .map((e) => ({ ...e, questions: e.questions.map(({ correctAnswer, explanation, ...q }: Row) => q) }));
      return ok({
        data: {
          school: db.school,
          students: [publicStudent(me)],
          exams,
          attempts: db.attempts.filter((a) => a.studentId === me.id),
          auditLogs: [],
        },
      });
    }
    return ok({ data: publicData(db) });
  }

  /* ---- school ---- */
  if (method === 'POST' && path === '/school') {
    const denied = requireAdmin(); if (denied) return denied;
    db.school = { ...db.school, ...body };
    audit(db, actor, 'SCHOOL_UPDATE', 'School profile updated');
    save(db);
    return ok();
  }

  /* ---- students ---- */
  if (method === 'POST' && path === '/students') {
    const denied = requireAdmin(); if (denied) return denied;
    const fullName = String(body.fullName || '').trim();
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!fullName || !username) return fail('Full name and username are required.');
    if (password.length < 8) return fail('Password must be at least 8 characters.');
    if (db.students.some((s) => norm(s.username) === norm(username)) || norm(db.admin?.username) === norm(username))
      return fail('That username is already taken.');
    let n = db.students.length + 1;
    while (db.students.some((s) => s.studentId === `STU${String(n).padStart(3, '0')}`)) n++;
    const student = {
      id: uid('stu'), studentId: `STU${String(n).padStart(3, '0')}`, fullName, username,
      passwordHash: await hashPassword(password), classGrade: String(body.classGrade || '').trim(),
      gender: body.gender || 'Male', email: String(body.email || '').trim(), status: 'active', createdAt: nowISO(),
    };
    db.students.push(student);
    audit(db, actor, 'STUDENT_CREATE', `Created ${student.studentId} (${fullName})`);
    save(db);
    return ok({ student: publicStudent(student) });
  }

  if (method === 'POST' && (m = path.match(/^\/students\/([^/]+)\/status$/))) {
    const denied = requireAdmin(); if (denied) return denied;
    const st = db.students.find((s) => s.id === m![1]);
    if (!st) return fail('Student not found.');
    if (!['active', 'deactivated'].includes(body.status)) return fail('Invalid status.');
    st.status = body.status;
    audit(db, actor, 'STUDENT_STATUS', `${st.studentId} set to ${st.status}`);
    save(db);
    return ok();
  }

  if (method === 'POST' && (m = path.match(/^\/students\/([^/]+)\/reset-password$/))) {
    const denied = requireAdmin(); if (denied) return denied;
    const st = db.students.find((s) => s.id === m![1]);
    if (!st) return fail('Student not found.');
    if (String(body.newPassword || '').length < 8) return fail('Password must be at least 8 characters.');
    st.passwordHash = await hashPassword(String(body.newPassword));
    audit(db, actor, 'PASSWORD_RESET', `Password reset for ${st.studentId}`);
    save(db);
    return ok();
  }

  if (method === 'DELETE' && (m = path.match(/^\/students\/([^/]+)$/))) {
    const denied = requireAdmin(); if (denied) return denied;
    const st = db.students.find((s) => s.id === m![1]);
    if (!st) return fail('Student not found.');
    db.students = db.students.filter((s) => s.id !== st.id);
    db.attempts = db.attempts.filter((a) => a.studentId !== st.id);
    audit(db, actor, 'STUDENT_DELETE', `Deleted ${st.studentId} (${st.fullName})`);
    save(db);
    return ok();
  }

  /* ---- exams ---- */
  if (method === 'POST' && path === '/exams') {
    const denied = requireAdmin(); if (denied) return denied;
    const title = String(body.title || '').trim();
    if (!title) return fail('Exam title is required.');
    if (!Array.isArray(body.questions) || body.questions.length === 0) return fail('Add at least one question.');
    const exam = { ...body, title, id: uid('exam'), status: body.status || 'draft', createdAt: nowISO() };
    db.exams.unshift(exam);
    audit(db, actor, 'EXAM_CREATE', `Created exam "${title}" (${exam.questions.length} questions)`);
    save(db);
    return ok({ exam });
  }

  if (method === 'POST' && (m = path.match(/^\/exams\/([^/]+)\/status$/))) {
    const denied = requireAdmin(); if (denied) return denied;
    const exam = db.exams.find((e) => e.id === m![1]);
    if (!exam) return fail('Exam not found.');
    if (!['draft', 'active', 'closed', 'cancelled'].includes(body.status)) return fail('Invalid status.');
    exam.status = body.status;
    audit(db, actor, 'EXAM_STATUS', `"${exam.title}" set to ${exam.status}`);
    save(db);
    return ok();
  }

  if (method === 'DELETE' && (m = path.match(/^\/exams\/([^/]+)$/))) {
    const denied = requireAdmin(); if (denied) return denied;
    const exam = db.exams.find((e) => e.id === m![1]);
    if (!exam) return fail('Exam not found.');
    db.exams = db.exams.filter((e) => e.id !== exam.id);
    db.attempts = db.attempts.filter((a) => a.examId !== exam.id);
    audit(db, actor, 'EXAM_DELETE', `Deleted exam "${exam.title}"`);
    save(db);
    return ok();
  }

  /* ---- taking exams (students) ---- */
  if (method === 'POST' && (m = path.match(/^\/exams\/([^/]+)\/start$/))) {
    if (isAdmin) return fail('Sign in as a student to take an exam.');
    const exam = db.exams.find((e) => e.id === m![1]);
    const me = db.students.find((s) => s.id === session.userId);
    if (!exam || !me) return fail('Exam not found.');
    if (exam.status !== 'active') return fail('This exam is not open.');
    if (exam.targetClass && exam.targetClass !== 'All' && exam.targetClass !== me.classGrade)
      return fail('This exam is not assigned to your class.');
    const mine = db.attempts.filter((a) => a.examId === exam.id && a.studentId === me.id && a.status !== 'reset_archived');
    if (mine.some((a) => a.status === 'submitted' || a.status === 'graded')) return fail('You have already submitted this exam.');
    let attempt = mine.find((a) => a.status === 'in_progress');
    if (!attempt) {
      const closed = examOpenError(exam);
      if (closed) return fail(closed);
      attempt = {
        id: uid('att'), examId: exam.id, studentId: me.id, studentName: me.fullName, status: 'in_progress',
        startedAt: nowISO(), answers: {}, score: 0, totalMarks: exam.totalMarks, percentage: 0, passed: false,
      };
      db.attempts.push(attempt);
      save(db);
    }
    const safeExam = { ...exam, questions: exam.questions.map(({ correctAnswer, explanation, ...q }: Row) => q) };
    return ok({ exam: safeExam, attempt });
  }

  if (method === 'POST' && (m = path.match(/^\/exams\/([^/]+)\/save-progress$/))) {
    const att = db.attempts.find((a) => a.id === body.attemptId && a.examId === m![1] && a.studentId === session.userId);
    if (!att || att.status !== 'in_progress') return fail('Attempt not found.');
    att.answers = body.answers || {};
    att.timeSpentSeconds = Number(body.timeSpentSeconds) || 0;
    save(db);
    return ok();
  }

  if (method === 'POST' && (m = path.match(/^\/exams\/([^/]+)\/submit$/))) {
    const att = db.attempts.find((a) => a.id === body.attemptId && a.examId === m![1] && a.studentId === session.userId);
    const exam = db.exams.find((e) => e.id === m![1]);
    if (!att || !exam) return fail('Attempt not found.');
    if (att.status !== 'in_progress') return fail('This exam was already submitted.');
    const answers = body.answers || {};
    const g = grade(exam, answers);
    Object.assign(att, {
      answers, status: 'submitted', submittedAt: nowISO(), timeSpentSeconds: Number(body.timeSpentSeconds) || 0,
      score: g.score, totalMarks: g.total, percentage: g.percentage, passed: g.passed,
    });
    audit(db, session.fullName, 'EXAM_SUBMIT', `Submitted "${exam.title}" — ${g.score}/${g.total}`);
    save(db);
    return ok({
      score: g.score, totalPossible: g.total, percentage: g.percentage, passed: g.passed, attempt: att,
      exam: exam.showResultsImmediately ? exam : undefined,
    });
  }

  if (method === 'POST' && (m = path.match(/^\/results\/([^/]+)\/reset$/))) {
    const denied = requireAdmin(); if (denied) return denied;
    const att = db.attempts.find((a) => a.id === m![1]);
    if (!att) return fail('Attempt not found.');
    att.status = 'reset_archived';
    att.resetReason = String(body.reason || '');
    audit(db, actor, 'RETAKE_ALLOWED', `${att.studentName}: ${att.resetReason || 'no reason given'}`);
    save(db);
    return ok();
  }

  /* ---- backup / restore ---- */
  if (method === 'GET' && path === '/backup') {
    const denied = requireAdmin(); if (denied) return denied;
    return ok({ backup: { app: 'oems', version: 2, exportedAt: nowISO(), db } });
  }

  if (method === 'POST' && path === '/restore') {
    const denied = requireAdmin(); if (denied) return denied;
    const inc = body?.backup?.db;
    if (body?.backup?.app !== 'oems' || !inc || !inc.admin || !Array.isArray(inc.students) || !Array.isArray(inc.exams) || !Array.isArray(inc.attempts))
      return fail('This file is not a valid OEMS backup.');
    const restored: DB = { ...defaultDB(), ...inc, auditLogs: Array.isArray(inc.auditLogs) ? inc.auditLogs : [] };
    audit(restored, actor, 'RESTORE', 'Data restored from backup');
    save(restored);
    setSession(null); // the restored admin account may differ; sign in again
    return ok();
  }

  return fail(`Unknown request: ${method} ${path}`);
}
