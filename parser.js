// Turns plain exam text (extracted from a PDF or pasted) into questions.
//
// Expected layout:
//   Optional title line
//   1. Question text
//   A. option      (also  A) option  or  (A) option)
//   B. option
//   Answer: B      (or put all answers at the end:  Answer Key: 1-B, 2-A, ...)
//
// Returns { title, questions: [{q, options[], answer|null}], warnings[] }

function parseExamText(text) {
  const warnings = [];
  const lines = String(text)
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    // drop empty lines and bare page numbers
    .filter((l) => l && !/^(page\s*)?\d{1,3}(\s*(of|\/)\s*\d{1,3})?$/i.test(l));

  const reKeyHead = /^(?:answer\s*key|answers)\b\s*:?\s*(.*)$/i;
  const reAns = /^(?:correct\s+)?(?:answer|ans)\b\s*[:.\-]?\s*\(?([A-Ha-h])\)?(?![A-Za-z0-9])/i;
  const reOpt = /^\(?([A-Ha-h])[.)]\s*(.+)$/;
  const reQ = /^(?:Q(?:uestion)?\.?\s*)?(\d{1,3})\s*[.):\-]\s*(.+)$/i;
  const rePair = /(\d{1,3})\s*[.:\-)]?\s*\(?([A-Ha-h])\)?(?![A-Za-z0-9])/g;

  let title = "";
  let cur = null;
  let inKey = false;
  const raw = [];
  const key = {};

  const addPairs = (s) => {
    let m;
    rePair.lastIndex = 0;
    while ((m = rePair.exec(s))) key[parseInt(m[1], 10)] = m[2].toUpperCase();
  };

  for (const line of lines) {
    let m;
    if ((m = reKeyHead.exec(line))) { inKey = true; addPairs(m[1]); continue; }
    if (inKey) { addPairs(line); continue; }
    if (cur && (m = reAns.exec(line))) { cur.letter = m[1].toUpperCase(); continue; }
    if (cur && (m = reOpt.exec(line))) { cur.options.push(m[2]); continue; }
    if ((m = reQ.exec(line))) {
      cur = { num: parseInt(m[1], 10), q: m[2], options: [], letter: null };
      raw.push(cur);
      continue;
    }
    if (cur) {
      // wrapped line: belongs to the last option, or to the question text
      if (cur.options.length) cur.options[cur.options.length - 1] += " " + line;
      else cur.q += " " + line;
    } else if (!title) {
      title = line.slice(0, 100);
    }
  }

  const questions = [];
  raw.forEach((c) => {
    const label = "Question " + c.num;
    if (c.options.length < 2) {
      warnings.push(label + ": fewer than 2 options found, skipped.");
      return;
    }
    const letter = c.letter || key[c.num] || null;
    let answer = null;
    if (letter) {
      const idx = letter.charCodeAt(0) - 65;
      if (idx < c.options.length) answer = idx;
      else warnings.push(label + ": answer " + letter + " does not match any option.");
    }
    if (answer === null) warnings.push(label + ": correct answer not found, please select it.");
    questions.push({ q: c.q.trim(), options: c.options.map((o) => o.trim()), answer });
  });

  return { title, questions, warnings };
}

if (typeof module !== "undefined") module.exports = { parseExamText };
