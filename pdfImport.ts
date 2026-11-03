/**
 * Question import: PDF / text -> multiple-choice questions, entirely in the browser.
 * No server and no API key. PDFs need a text layer (scanned images are not OCR'd).
 */
import type { ExamQuestion } from './types';

/* ------------------------------------------------ PDF -> lines of text -- */
interface TextItem { str: string; transform: number[]; width: number; height: number }

/** Rebuild visual lines from pdf.js text items (grouped by baseline, ordered left to right). */
export function itemsToLines(items: TextItem[]): string[] {
  const rows: { y: number; parts: { x: number; w: number; s: string }[] }[] = [];
  for (const it of items) {
    if (!it || typeof it.str !== 'string' || it.str === '') continue;
    const x = it.transform[4], y = it.transform[5];
    const tol = Math.max(2, (it.height || 10) * 0.5);
    let row = rows.find((r) => Math.abs(r.y - y) <= tol);
    if (!row) { row = { y, parts: [] }; rows.push(row); }
    row.parts.push({ x, w: it.width || 0, s: it.str });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows
    .map((r) => {
      r.parts.sort((a, b) => a.x - b.x);
      let out = '';
      let prevEnd = -Infinity;
      for (const p of r.parts) {
        const gap = p.x - prevEnd;
        if (out && gap > 1.5 && !out.endsWith(' ') && !p.s.startsWith(' ')) out += ' ';
        out += p.s;
        prevEnd = p.x + p.w;
      }
      return out.replace(/\s+/g, ' ').trim();
    })
    .filter(Boolean);
}

export async function extractPdfLines(file: File): Promise<string[]> {
  // Loaded on demand so students never download the PDF engine.
  // @ts-ignore - resolved by the bundler
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // @ts-ignore - Vite "?url" import
  const workerUrl: string = (await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
  const lines: string[] = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      lines.push(...itemsToLines(content.items as TextItem[]));
    }
  } finally {
    await doc.destroy();
  }
  return lines;
}

/* ----------------------------------------------- lines -> questions -- */
export interface ParseResult { questions: ExamQuestion[]; skipped: number; missingAnswers: number }

const LETTERS = 'ABCDEFGH';
const MARK = '[*✓✔√]';
const nextLetter = (l: string) => LETTERS[LETTERS.indexOf(l) + 1] || '';

const QUESTION_START = /^(?:Q(?:uestion)?\.?\s*)?(\d{1,3})\s*[.):\-–]\s*(\S.*)$/i;
const OPTION_START = new RegExp(`^${MARK}?\\s*\\(?([A-Ha-h])[.)]\\s+(\\S.*)$`);
const INLINE_ANSWER = /^(?:correct\s+(?:answer|option)|answer|ans|key)\s*[:=\-–]\s*\(?([A-Ha-h])\)?(?=[\s.)]|$)/i;
const KEY_HEADING = /^(?:answer\s*key|answers?|marking\s*scheme|solutions?|key)\s*:?$/i;
const PAGE_NOISE = /^(?:page\s*)?\d{1,4}(?:\s*(?:of|\/)\s*\d{1,4})?$|^[-–—]\s*\d{1,4}\s*[-–—]$/i;

/** Split "A. x B. y C. z" into separate options, following the A,B,C… order. */
function splitInline(first: { label: string; text: string }) {
  const out = [{ ...first }];
  let rest = first.text;
  let cur = out[0];
  for (;;) {
    const nl = nextLetter(cur.label);
    if (!nl) break;
    const m = new RegExp(`\\s\\(?${nl}[.)]\\s+(?=\\S)`, 'i').exec(rest);
    if (!m) break;
    cur.text = rest.slice(0, m.index).trim();
    rest = rest.slice(m.index + m[0].length);
    cur = { label: nl, text: rest };
    out.push(cur);
  }
  cur.text = rest.trim();
  return out;
}

function cleanOption(raw: string) {
  let text = raw.trim();
  let marked = false;
  if (/(?:\s*[*✓✔√]|\s*\((?:correct|answer)\))\s*$/i.test(text)) {
    marked = true;
    text = text.replace(/(?:\s*[*✓✔√]|\s*\((?:correct|answer)\))\s*$/i, '').trim();
  }
  return { text, marked };
}

export function parseQuestions(lines: string[], defaultMarks = 1): ParseResult {
  type Draft = { num: number; text: string; options: { label: string; text: string }[]; correct: string };
  const drafts: Draft[] = [];
  const keyMap = new Map<number, string>();
  let cur: Draft | null = null;
  let inKey = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+/g, ' ').trim();
    if (!line || PAGE_NOISE.test(line)) continue;

    if (KEY_HEADING.test(line) && drafts.length) { inKey = true; cur = null; continue; }

    if (inKey) {
      const re = /(\d{1,3})\s*[.):\-–]?\s*\(?([A-Ha-h])\)?(?=[\s,;]|$)/g;
      let k: RegExpExecArray | null;
      while ((k = re.exec(line))) keyMap.set(Number(k[1]), k[2].toUpperCase());
      continue;
    }

    // Answer line for the current question
    const ans = INLINE_ANSWER.exec(line);
    if (ans && cur) { cur.correct = ans[1].toUpperCase(); continue; }

    // Option line (must continue A, B, C… in order)
    const om = OPTION_START.exec(line);
    if (om && cur) {
      const label = om[1].toUpperCase();
      const expected = cur.options.length ? nextLetter(cur.options[cur.options.length - 1].label) : 'A';
      if (label === expected) {
        const lead = new RegExp(`^${MARK}`).test(line);
        for (const [i, o] of splitInline({ label, text: om[2] }).entries()) {
          const c = cleanOption(o.text);
          cur.options.push({ label: o.label, text: c.text });
          if (c.marked || (i === 0 && lead)) cur.correct = o.label;
        }
        continue;
      }
    }

    // New question
    const qm = QUESTION_START.exec(line);
    if (qm) {
      const n = Number(qm[1]);
      const last: number = drafts.length ? drafts[drafts.length - 1].num : 0;
      if (!drafts.length || n > last || n === 1) {
        let text = qm[2];
        const draft: Draft = { num: n, text, options: [], correct: '' };
        // "1. Question? A. x B. y C. z D. w" on one line
        const first = /\s\(?A[.)]\s+\S/.exec(text);
        if (first && /\s\(?B[.)]\s+\S/.test(text.slice(first.index + 1))) {
          const optPart = text.slice(first.index + 1).replace(/^\(?[Aa][.)]\s+/, '');
          draft.text = text.slice(0, first.index).trim();
          for (const o of splitInline({ label: 'A', text: optPart })) {
            const c = cleanOption(o.text);
            draft.options.push({ label: o.label, text: c.text });
            if (c.marked) draft.correct = o.label;
          }
        }
        drafts.push(draft);
        cur = draft;
        continue;
      }
    }

    // Continuation of the previous line
    if (cur) {
      if (cur.options.length) {
        const o = cur.options[cur.options.length - 1];
        o.text = `${o.text} ${line}`.trim();
      } else cur.text = `${cur.text} ${line}`.trim();
    }
  }

  const stamp = Date.now();
  const questions: ExamQuestion[] = [];
  let skipped = 0, missingAnswers = 0;
  for (const d of drafts) {
    const options = d.options.filter((o) => o.text);
    if (!d.text.trim() || options.length < 2) { skipped++; continue; }
    let correct = d.correct || keyMap.get(d.num) || '';
    if (correct && !options.some((o) => o.label === correct)) correct = '';
    if (!correct) missingAnswers++;
    const id = `q_${stamp}_${questions.length}_${Math.random().toString(36).slice(2, 6)}`;
    questions.push({
      id, questionNumber: questions.length + 1, type: 'multiple_choice', text: d.text.trim(),
      options: options.map((o) => ({ id: `${id}_${o.label}`, label: o.label, text: o.text })),
      correctAnswer: correct, marks: defaultMarks,
    });
  }
  return { questions, skipped, missingAnswers };
}

export const textToLines = (text: string) => text.split(/\r?\n/);
