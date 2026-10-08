import test from 'node:test';
import assert from 'node:assert';
import { parseChoices, composeReply } from '../src/renderer/js/choices.mjs';

test('lettered multiple-choice questions are detected', () => {
  const md = `I need a few details before building this.

1. **Which database should we use?**
   A) PostgreSQL
   B) SQLite
   C) MySQL

2. Which features do you need? (select all that apply)
   - a) Authentication
   - b) Full-text search
   - c) CSV export

Let me know and I'll start.`;
  const q = parseChoices(md);
  assert.strictEqual(q.length, 2);
  assert.deepStrictEqual(q[0], { question: 'Which database should we use?', options: ['PostgreSQL', 'SQLite', 'MySQL'], multiSelect: false });
  assert.deepStrictEqual(q[1].options, ['Authentication', 'Full-text search', 'CSV export']);
  assert.strictEqual(q[1].multiSelect, true);
});

test('bullet options count only when the question asks for a choice', () => {
  assert.strictEqual(parseChoices('Which framework do you prefer?\n- React\n- Vue\n- Svelte').length, 1);
  // An explanation after a rhetorical question is not a choice.
  assert.deepStrictEqual(parseChoices('Why does this fail?\n- the cache is stale\n- the key is wrong'), []);
});

test('bold labels and markdown inside options are cleaned', () => {
  const q = parseChoices('Pick one?\n**A)** Use `fetch`\n**B)** Use **axios**');
  assert.deepStrictEqual(q[0].options, ['Use fetch', 'Use axios']);
});

test('questions must end the message', () => {
  const md = 'Which one?\nA) x\nB) y\n\n' + Array.from({ length: 6 }, (_, i) => `More explanation ${i}.`).join('\n');
  assert.deepStrictEqual(parseChoices(md), []);
});

test('code blocks, plans and single options are ignored', () => {
  assert.deepStrictEqual(parseChoices('```\nWhich?\nA) x\nB) y\n```'), []);
  assert.deepStrictEqual(parseChoices('## Plan\n- [ ] 1. Add sub\n- [ ] 2. Export it'), []);
  assert.deepStrictEqual(parseChoices('Which one?\nA) only'), []);
  assert.deepStrictEqual(parseChoices(''), []);
});

test('numbered questions with numbered sub-options do not swallow the next question', () => {
  const md = 'Which language?\n1. Python\n2. Go\nWhich editor?\n1. Vim\n2. VS Code';
  const q = parseChoices(md);
  assert.strictEqual(q.length, 2);
  assert.deepStrictEqual(q[1].options, ['Vim', 'VS Code']);
});

test('composeReply formats one or many answers', () => {
  const qs = [{ question: 'A?' }, { question: 'B?' }];
  assert.strictEqual(composeReply([qs[0]], [{ selected: ['x'] }]), 'x');
  assert.strictEqual(composeReply(qs, [{ selected: ['x', 'y'] }, { selected: [], other: 'custom' }]), '1. A?\n   → x, y\n2. B?\n   → custom');
});
