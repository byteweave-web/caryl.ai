// lib/kernel/handlers/math.js
// PURE_LOGIC handler: evaluate an arithmetic expression WITHOUT eval/Function.
// A hand-rolled tokenizer + shunting-yard parser (no new deps) means the only things
// that can ever run are +, -, *, /, % and parentheses — never arbitrary code. This is
// what lets the Kernel replace the GUI calculator: math is solved by computation, and
// anything that isn't pure arithmetic is rejected rather than executed.

const BIN_PREC = { '+': 2, '-': 2, '*': 3, '/': 3, '%': 3 };
const UNARY = { 'u-': 4, 'u+': 4 };
const RIGHT_ASSOC = { 'u-': true, 'u+': true };

// Rewrite human percentages into plain arithmetic before tokenizing:
//   "12.5% of 340" -> "(12.5/100*340)"
//   "50%"          -> "(50/100)"      (but NOT "10 % 3", which stays modulo)
function preprocessPercent(src) {
  let s = src.replace(/(\d+(?:\.\d+)?)\s*%\s*of\s*(\d+(?:\.\d+)?)/gi, '($1/100*$2)');
  // A trailing "%" not followed by another number is a percentage, not modulo.
  s = s.replace(/(\d+(?:\.\d+)?)\s*%(?!\s*\d)/g, '($1/100)');
  return s;
}

// Text -> token list. Throws on any character that isn't part of arithmetic.
function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c >= '0' && c <= '9' || c === '.') {
      let j = i, seenDot = false;
      while (j < src.length && ((src[j] >= '0' && src[j] <= '9') || (src[j] === '.' && !seenDot))) {
        if (src[j] === '.') seenDot = true;
        j++;
      }
      const numStr = src.slice(i, j);
      if (numStr === '.') throw new Error('bad number');
      tokens.push({ t: 'num', v: Number(numStr) });
      i = j;
      continue;
    }
    if ('+-*/%'.includes(c)) { tokens.push({ t: 'op', v: c }); i++; continue; }
    if (c === '(') { tokens.push({ t: 'lp' }); i++; continue; }
    if (c === ')') { tokens.push({ t: 'rp' }); i++; continue; }
    throw new Error('unexpected character: ' + c);
  }
  return tokens;
}

// Shunting-yard -> RPN, tagging +/- as unary when they sit where a value is expected.
function toRPN(tokens) {
  const out = [];
  const ops = [];
  let prev = null; // previous token type, to detect unary context
  for (const tk of tokens) {
    if (tk.t === 'num') {
      out.push(tk);
    } else if (tk.t === 'op') {
      const unary = (prev === null || prev === 'op' || prev === 'lp');
      let op = tk.v;
      if (unary) {
        if (op === '-') op = 'u-';
        else if (op === '+') op = 'u+';
        else throw new Error('operator ' + op + ' has no left operand');
      }
      const prec = (op in UNARY) ? UNARY[op] : BIN_PREC[op];
      while (ops.length) {
        const top = ops[ops.length - 1];
        if (top === '(') break;
        const topPrec = (top in UNARY) ? UNARY[top] : BIN_PREC[top];
        if (topPrec > prec || (topPrec === prec && !RIGHT_ASSOC[op])) out.push({ t: 'op', v: ops.pop() });
        else break;
      }
      ops.push(op);
    } else if (tk.t === 'lp') {
      ops.push('(');
    } else if (tk.t === 'rp') {
      let found = false;
      while (ops.length) {
        const o = ops.pop();
        if (o === '(') { found = true; break; }
        out.push({ t: 'op', v: o });
      }
      if (!found) throw new Error('unbalanced parentheses');
    }
    prev = tk.t;
  }
  while (ops.length) {
    const o = ops.pop();
    if (o === '(') throw new Error('unbalanced parentheses');
    out.push({ t: 'op', v: o });
  }
  return out;
}

function applyBinary(op, a, b) {
  switch (op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': if (b === 0) throw new Error('division by zero'); return a / b;
    case '%': if (b === 0) throw new Error('division by zero'); return a % b;
    default: throw new Error('unknown operator ' + op);
  }
}

function evalRPN(rpn) {
  const st = [];
  for (const tk of rpn) {
    if (tk.t === 'num') { st.push(tk.v); continue; }
    if (tk.v === 'u-') { if (!st.length) throw new Error('missing operand'); st.push(-st.pop()); continue; }
    if (tk.v === 'u+') { if (!st.length) throw new Error('missing operand'); continue; }
    if (st.length < 2) throw new Error('missing operand');
    const b = st.pop(), a = st.pop();
    st.push(applyBinary(tk.v, a, b));
  }
  if (st.length !== 1) throw new Error('malformed expression');
  return st[0];
}

// Trim floating-point noise: integers print bare, decimals to 6 places, no trailing zeros.
function formatNumber(n) {
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toFixed(6)));
}

// evaluate(expression) -> { ok:true, value, formatted } | { ok:false, error }
function evaluate(expression) {
  try {
    const src = String(expression == null ? '' : expression).trim();
    if (!src) return { ok: false, error: 'empty expression' };
    const rpn = toRPN(tokenize(preprocessPercent(src)));
    if (!rpn.length) return { ok: false, error: 'empty expression' };
    const value = evalRPN(rpn);
    if (!Number.isFinite(value)) return { ok: false, error: 'result is not a finite number' };
    return { ok: true, value, formatted: formatNumber(value) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Kernel handler entrypoint. params.expression is the arithmetic to solve.
function run(params) {
  const expr = params && params.expression;
  const r = evaluate(expr);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, value: r.value, speak: String(expr).trim() + ' = ' + r.formatted };
}

module.exports = { evaluate, run, formatNumber, preprocessPercent };
