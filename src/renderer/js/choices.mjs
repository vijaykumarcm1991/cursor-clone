// Detects multiple-choice questions written as plain text at the end of an AI reply, e.g.
//
//   1. Which database should we use?
//      A) PostgreSQL
//      B) SQLite
//
// so the chat can offer clickable answers. Kept DOM-free so it can be unit-tested in Node.
// Conservative by design: lettered options (A/B/C) are accepted after any question, while plain
// bullets or numbers are only treated as choices when the question reads like a choice.

const LABELED = /^\s*(?:[-*+]\s+)?(?:\[[ xX]?\]\s*)?\(?([A-Ja-j]|\d{1,2})[).:]\s+(.+?)\s*$/;
const BULLET = /^\s*[-*+]\s+(?:\[[ xX]?\]\s*)?(.+?)\s*$/;
const CHOICE_WORDS = /\b(which|choose|select|pick|prefer|preference|would you like|do you want|should (?:i|we)|options?|or)\b/i;
const MULTI_WORDS = /\b(select all|choose all|all that apply|multiple|multi-select|one or more|any of)\b/i;
const MAX_TAIL_LINES = 3;

export function stripInline(s) {
  return String(s)
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|\W)\*([^*\s][^*]*)\*(?=\W|$)/g, '$1$2')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function questionText(line) {
  let t = line.trim();
  if (!t) return null;
  t = t.replace(/^#{1,6}\s+/, '').replace(/^>\s*/, '').replace(/^[-*+]\s+/, '');
  t = t.replace(/^(?:\*\*|__)?(?:Q(?:uestion)?\s*)?\d{1,2}[).:]?(?:\*\*|__)?\s+/i, '');
  t = stripInline(t);
  return /\?\s*(?:\((?:[^)]*)\))?$/.test(t) ? t : null;
}

function optionKind(label) {
  return /\d/.test(label) ? 'number' : 'letter';
}

/**
 * @param {string} markdown
 * @returns {Array<{question: string, options: string[], multiSelect: boolean}>} empty when none found
 */
export function parseChoices(markdown) {
  if (!markdown) return [];
  const lines = String(markdown).replace(/```[\s\S]*?```/g, '').split(/\r?\n/);
  const found = [];
  let lastOptionLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const q = questionText(lines[i]);
    if (!q) continue;
    const options = [];
    let kind = null;
    let blanks = 0;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim()) {
        if (++blanks > 1 && options.length) break;
        continue;
      }
      blanks = 0;
      if (options.length && questionText(line)) break; // next question
      const m = line.replace(/\*\*|__/g, '').match(LABELED);
      let k = null;
      let text = null;
      if (m) { k = optionKind(m[1]); text = m[2]; }
      else {
        const b = line.match(BULLET);
        if (b) { k = 'bullet'; text = b[1]; }
      }
      if (!k || (kind && k !== kind)) break;
      kind = kind || k;
      text = stripInline(text).replace(/^[-–—:]\s*/, '');
      if (!text) break;
      options.push(text);
    }
    const ok = options.length >= 2 && options.length <= 10 && options.every((o) => o.length <= 160)
      && (kind === 'letter' || CHOICE_WORDS.test(q));
    if (ok) {
      found.push({ question: q, options, multiSelect: MULTI_WORDS.test(q) });
      lastOptionLine = j - 1;
      i = j - 1;
    }
  }
  if (!found.length) return [];
  // Only offer answers when the questions end the message (it's waiting for the user).
  const tail = lines.slice(lastOptionLine + 1).filter((l) => l.trim()).length;
  return tail <= MAX_TAIL_LINES ? found : [];
}

/** Compose the reply text sent when the user answers plain-text questions. */
export function composeReply(questions, answers) {
  const fmt = (a) => [...(a && a.selected || []), ...(a && a.other ? [a.other] : [])].join(', ') || '(no answer)';
  if (questions.length === 1) return fmt(answers[0]);
  return questions.map((q, i) => `${i + 1}. ${q.question}\n   → ${fmt(answers[i])}`).join('\n');
}
