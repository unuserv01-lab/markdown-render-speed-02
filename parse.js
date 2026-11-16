// MARKED-X — a faster drop-in for marked 18.1.3.
//
// The parser itself is marked, vendored byte for byte in vendor/marked/
// (MIT, MarkedJS; see vendor/marked/LICENSE and NOTICE). This file only
// removes work marked repeats on every token:
//
//   1. It calls Lexer/Parser directly instead of going through
//      marked.parse(), whose wrapper re-spreads the options on each call.
//   2. It guards every tokenizer with the first character(s) it can ever
//      match, so the common path — plain text — skips about nine regex
//      executions per token instead of running them all to fail.
//   3. It skips whole-document regex passes whose result is already known:
//      no CR means no CR normalisation, and the table / setext-heading
//      regexes only run when a cheap line scan finds a delimiter row or
//      an underline row that could let them match.
//
// Every guard is a superset test: it only skips a tokenizer when the
// tokenizer's own anchored regex provably cannot match at this position,
// so the HTML is identical to marked's on every input.
//
// Nothing is cached between parse() calls: each call lexes and renders
// from scratch. The objects shared below hold only immutable rule tables
// and stateless tokenizer/renderer instances — the same reuse marked
// itself does when one options object is used repeatedly.

import { Lexer, Parser, Tokenizer, getDefaults } from "./vendor/marked/marked.esm.js";

const options = getDefaults();

// ---------------------------------------------------------------------------
// Small scanners used by the guards. Each mirrors one regex closely enough
// that it returns false only when that regex cannot match.
// ---------------------------------------------------------------------------

// One cell of a GFM table delimiter row: `:?-+:?` plus trailing spaces.
// Returns the position after the cell, or -1 when there is no cell here.
function tableCell(src, pos) {
  if (src.charCodeAt(pos) === 58) pos++; // ':'
  if (src.charCodeAt(pos) !== 45) return -1; // need at least one '-'
  while (src.charCodeAt(pos) === 45) pos++;
  if (src.charCodeAt(pos) === 58) pos++;
  while (src.charCodeAt(pos) === 32) pos++;
  return pos;
}

// True when the second line of src looks like a table delimiter row
// (`| :-: | --- |` etc.), i.e. when the table regex has any chance to match.
function hasTableDelimiter(src) {
  const nl = src.indexOf("\n");
  if (nl < 0) return false;
  let pos = nl + 1;
  let spaces = 0;
  while (spaces < 3 && src.charCodeAt(pos) === 32) {
    pos++;
    spaces++;
  }
  if (src.charCodeAt(pos) === 124) {
    // '|'
    pos++;
    while (src.charCodeAt(pos) === 32) pos++;
  }
  pos = tableCell(src, pos);
  if (pos < 0) return false;
  for (;;) {
    if (src.charCodeAt(pos) === 124) {
      pos++;
      while (src.charCodeAt(pos) === 32) pos++;
      if (pos >= src.length || src.charCodeAt(pos) === 10) return true;
      pos = tableCell(src, pos);
      if (pos < 0) return false;
      continue;
    }
    break;
  }
  return pos >= src.length || src.charCodeAt(pos) === 10;
}

// True when some line after the first, before the first blank line, is a
// setext underline (`===` or `---` on its own line). The lheading regex
// can only match when such a line exists inside the current block.
function hasSetextUnderline(src) {
  let pos = src.indexOf("\n");
  if (pos < 0) return false;
  pos++;
  const len = src.length;
  while (pos < len) {
    let q = pos;
    while (q < len && (src.charCodeAt(q) === 32 || src.charCodeAt(q) === 9)) q++;
    if (q >= len || src.charCodeAt(q) === 10) return false; // blank line
    let r = pos;
    let spaces = 0;
    while (spaces < 3 && src.charCodeAt(r) === 32) {
      r++;
      spaces++;
    }
    const c = src.charCodeAt(r); // '=' (61) or '-' (45)
    if (c === 61 || c === 45) {
      let s = r;
      while (src.charCodeAt(s) === c) s++;
      while (src.charCodeAt(s) === 32 || src.charCodeAt(s) === 9) s++;
      if (s >= len || src.charCodeAt(s) === 10) return true;
    }
    const nl = src.indexOf("\n", pos);
    if (nl < 0) return false;
    pos = nl + 1;
  }
  return false;
}

// True when the url tokenizer has any chance to match at the start of src:
// a `www.` prefix, or a ':' / '@' in the first word (before whitespace or
// '<', past which no URL or email match can extend).
function urlPossible(src) {
  const c0 = src.charCodeAt(0);
  if (
    c0 === 119 &&
    src.charCodeAt(1) === 119 &&
    src.charCodeAt(2) === 119 &&
    src.charCodeAt(3) === 46
  ) {
    return true; // "www."
  }
  const firstOk =
    (c0 >= 48 && c0 <= 57) || // 0-9
    (c0 >= 65 && c0 <= 90) || // A-Z
    (c0 >= 97 && c0 <= 122) || // a-z
    c0 === 46 || // '.'
    c0 === 95 || // '_'
    c0 === 43 || // '+'
    c0 === 45; // '-'
  if (!firstOk) return false;
  for (let i = 1; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c === 58 || c === 64) return true; // ':' or '@'
    if (c === 32 || c === 10 || c === 9 || c === 13 || c === 60) return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// First-character guards on marked's tokenizers. Each wrapper only calls
// the original when the anchored regex could match at this position.
// ---------------------------------------------------------------------------

const proto = Tokenizer.prototype;

function guard(name, test) {
  const original = proto[name];
  proto[name] = function (src, ...rest) {
    if (!test(src)) return undefined;
    return original.call(this, src, ...rest);
  };
}

const isSpaceTabNl = (c) => c === 32 || c === 9 || c === 10;

// Block tokenizers. Leading ` {0,3}` in the regexes is why ' ' (32) is in
// almost every set; the other members are the regex's first real token.
guard("space", (s) => isSpaceTabNl(s.charCodeAt(0)));
guard("code", (s) => {
  const c = s.charCodeAt(0);
  return c === 32 || c === 9;
});
guard("fences", (s) => {
  const c = s.charCodeAt(0);
  return c === 32 || c === 96 || c === 126; // ' ', '`', '~'
});
guard("heading", (s) => {
  const c = s.charCodeAt(0);
  return c === 32 || c === 35; // ' ', '#'
});
guard("hr", (s) => {
  const c = s.charCodeAt(0);
  return c === 32 || c === 45 || c === 95 || c === 42; // ' ', '-', '_', '*'
});
guard("blockquote", (s) => {
  const c = s.charCodeAt(0);
  return c === 32 || c === 62; // ' ', '>'
});
guard("list", (s) => {
  const c = s.charCodeAt(0);
  return (
    c === 32 ||
    c === 42 || // '*'
    c === 43 || // '+'
    c === 45 || // '-'
    (c >= 48 && c <= 57) // digit
  );
});
guard("html", (s) => {
  const c = s.charCodeAt(0);
  return c === 32 || c === 60; // ' ', '<'
});
guard("def", (s) => {
  const c = s.charCodeAt(0);
  return c === 32 || c === 91; // ' ', '['
});
guard("table", (s) => s.charCodeAt(0) !== 10 && hasTableDelimiter(s));
guard("lheading", (s) => s.charCodeAt(0) !== 10 && hasSetextUnderline(s));

// Inline tokenizers (GFM rules). `paragraph`/`text` (block) and
// `inlineText` (inline) are the fallbacks and stay unguarded.
guard("escape", (s) => s.charCodeAt(0) === 92); // '\'
guard("tag", (s) => s.charCodeAt(0) === 60); // '<'
guard("link", (s) => {
  const c = s.charCodeAt(0);
  return c === 91 || c === 33; // '[', '!'
});
guard("reflink", (s) => {
  const c = s.charCodeAt(0);
  return c === 91 || c === 33; // '[', '!'
});
guard("emStrong", (s) => {
  const c = s.charCodeAt(0);
  return c === 42 || c === 95; // '*', '_'
});
guard("codespan", (s) => s.charCodeAt(0) === 96); // '`'
guard("br", (s) => {
  const c = s.charCodeAt(0);
  return c === 32 || c === 92; // ' ', '\'
});
guard("del", (s) => s.charCodeAt(0) === 126); // '~'
guard("autolink", (s) => s.charCodeAt(0) === 60); // '<'
guard("url", urlPossible);

// ---------------------------------------------------------------------------
// A faster `inlineText`: marked's GFM text regex is the single most
// expensive regex in the renderer — a lazy scan that re-checks four
// lookaheads at every character. This keeps the exact same match, but
// finds the end with one native search for the next position where a stop
// could occur, then decides the stop in plain code.
//
// A text run stops at the first position where any of these holds:
//   - the char can start another inline token: \ < ! [ ` * ~ _
//   - two or more spaces followed by a newline (hard break)
//   - an email-looking run (email-local chars then '@') starts
//   - http://, https:// or ftp:// starts (any letter case)
//   - www. starts, when the previous char is whitespace, '*', '_', '~',
//     '(' or ']' (or the run starts here)
//   - a non-alphanumeric char directly before mailto:/xmpp: (that char is
//     swallowed, the scheme itself is not)
// The native search below looks for exactly those markers; '@' needs a
// short walk back to the start of its email run, since the run — not the
// '@' — is where the text stops.
// ---------------------------------------------------------------------------

const NEXT_STOP =
  /[\\<!\[`*~_]| {2,}\n|@|mailto:|xmpp:|www\.|[hH][tT][tT][pP][sS]?:\/\/|[fF][tT][pP]:\/\//g;

function isAlnumCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

// [a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]: the email-local-part character class.
function isEmailLocalCode(c) {
  return (
    isAlnumCode(c) ||
    c === 46 || // '.'
    c === 33 || // '!'
    c === 35 || // '#'
    c === 36 || // '$'
    c === 37 || // '%'
    c === 38 || // '&'
    c === 39 || // "'"
    c === 42 || // '*'
    c === 43 || // '+'
    c === 45 || // '-'
    c === 47 || // '/'
    c === 61 || // '='
    c === 63 || // '?'
    c === 94 || // '^'
    c === 95 || // '_'
    c === 96 || // '`'
    c === 123 || // '{'
    c === 124 || // '|'
    c === 125 || // '}'
    c === 126 // '~'
  );
}

// The char before a `www.` that lets the text run stop before it.
function wwwPrevOk(ch) {
  return (
    ch === " " ||
    ch === "\t" ||
    ch === "\n" ||
    ch === "\r" ||
    ch === "\f" ||
    ch === "\v" ||
    ch === "*" ||
    ch === "_" ||
    ch === "~" ||
    ch === "(" ||
    ch === "]" ||
    /\s/.test(ch)
  );
}

function textMatchLength(s) {
  const len = s.length;
  if (len === 0) return 0;
  const c0 = s.charCodeAt(0);
  // One non-alphanumeric char directly before mailto:/xmpp:.
  if (
    !isAlnumCode(c0) &&
    (s.startsWith("mailto:", 1) || s.startsWith("xmpp:", 1))
  ) {
    return 1;
  }
  let pos;
  if (c0 === 96) {
    // leading run of backticks
    pos = 0;
    while (pos < len && s.charCodeAt(pos) === 96) pos++;
  } else if (c0 === 126) {
    // leading run of tildes
    pos = 0;
    while (pos < len && s.charCodeAt(pos) === 126) pos++;
  } else {
    pos = 1;
  }
  if (pos >= len) return len;
  for (;;) {
    NEXT_STOP.lastIndex = pos;
    const m = NEXT_STOP.exec(s);
    if (!m) return len;
    const k = m.index;
    // An email stop before k: the first '@' at or after pos whose
    // email-local run starts before k (the run's start is the stop).
    const at = s.indexOf("@", pos);
    if (at !== -1) {
      let r = at - 1;
      while (r >= 0 && isEmailLocalCode(s.charCodeAt(r))) r--;
      r++;
      if (r < at) {
        const stop = r < pos ? pos : r;
        // stop === k still ends the run here: the candidate at k is a
        // www./mailto:/@ that did not stop it, but the email run does.
        if (stop <= k) return stop;
      }
    }
    const hit = m[0];
    if (hit === "@") {
      pos = k + 1; // a bare '@' never stops the run
      continue;
    }
    const hc = hit.charCodeAt(0);
    if (hc === 32) return k; // "  \n" hard break
    if (hc === 104 || hc === 72 || hc === 102 || hc === 70) return k; // scheme
    if (hit === "www.") {
      if (wwwPrevOk(s[k - 1])) return k;
      pos = k + 1;
      continue;
    }
    if (hit === "mailto:" || hit === "xmpp:") {
      if (k > 0 && !isAlnumCode(s.charCodeAt(k - 1))) return k;
      pos = k + 1;
      continue;
    }
    return k; // a character that can start another inline token
  }
}

// marked's unescape for text tokens: only numeric character references
// (&#65; / &#x41;) are decoded; anything else passes through unchanged.
const numericRefTest = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const numericRefOrAmp =
  /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function unescapeNumeric(s) {
  if (!numericRefTest.test(s)) return s;
  return s.replace(numericRefOrAmp, (_m, dec, hex) => {
    if (dec === undefined && hex === undefined) return "&amp;";
    const n =
      hex === undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
    if (n === 0 || n > 1114111 || (n >= 55296 && n <= 57343)) return "\uFFFD";
    if (n === 38) return "&amp;";
    return String.fromCodePoint(n);
  });
}

proto.inlineText = function (src) {
  const len = textMatchLength(src);
  if (len <= 0) return undefined;
  const raw = src.slice(0, len);
  const inRaw = this.lexer.state.inRawBlock;
  return {
    type: "text",
    raw,
    text: inRaw ? raw : unescapeNumeric(raw),
    escaped: inRaw,
  };
};

// The stock Lexer.lex runs a CR-normalising regex over the whole input
// even when the input has no carriage return. Skip that pass when there
// is nothing to normalise; the rest is lex() as marked wrote it.
const origLex = Lexer.prototype.lex;
Lexer.prototype.lex = function (src) {
  if (src.includes("\r")) src = src.replace(/\r\n|\r/g, "\n");
  this.blockTokens(src, this.tokens);
  for (let i = 0; i < this.inlineQueue.length; i++) {
    const item = this.inlineQueue[i];
    this.state.inRawBlock = false;
    this.inlineTokens(item.src, item.tokens);
  }
  this.inlineQueue = [];
  return this.tokens;
};
void origLex;

// ---------------------------------------------------------------------------
// Entry point: the same checks and error text as marked.parse() with
// default options, then Lexer + Parser directly.
// ---------------------------------------------------------------------------

/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  if (typeof markdown === "undefined" || markdown === null) {
    throw new Error(
      "marked(): input parameter is undefined or null\nPlease report this to https://github.com/markedjs/marked.",
    );
  }
  if (typeof markdown !== "string") {
    throw new Error(
      "marked(): input parameter is of type " +
        Object.prototype.toString.call(markdown) +
        ", string expected\nPlease report this to https://github.com/markedjs/marked.",
    );
  }
  try {
    return Parser.parse(Lexer.lex(markdown, options), options);
  } catch (err) {
    err.message +=
      "\nPlease report this to https://github.com/markedjs/marked.";
    throw err;
  }
}
