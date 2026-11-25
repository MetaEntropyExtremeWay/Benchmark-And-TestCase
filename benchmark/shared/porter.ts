/**
 * Porter Stemmer —— **NLTK_EXTENSIONS 方言**（nltk.stem.porter.PorterStemmer() 默认模式）。
 * LoCoMo 官方 evaluation.py 用 NLTK 的 PorterStemmer 做 token 词干化，机械分要与
 * 公开分数可比就必须逐方言复刻，而不是照 1980 论文原版。与论文原版的差异
 * （均照 nltk/stem/porter.py 移植）：
 * - 词长 ≤2 直接返回；不规则形式池（sky/skies、dying、lying、tying、news、innings、
 *   outings、cannings、howe、proceed、exceed、succeed）优先短路；
 * - step1a/1b：4 字母词 ies→ie / ied→ie（dies→die、ties→tie）；
 * - step1c：y→i 仅当 y 前是辅音且剩余 stem 长 >1（enjoy→enjoy、happy→happi）；
 * - step2：abli→able 换成 bli→ble；追加 fulli→ful、logi→log（l 归 stem）；alli 命中后
 *   递归再过一遍 step2；
 * - *o（cvc）扩展：两字符「元音+辅音」结尾也算 cvc（ace→ace 而非 ac）。
 * 实现以 NLTK 官方 porter 测试词表（23531 词）全量对拍验证（见 test/porter.test.ts 注）。
 */

/** NLTK PorterStemmer 的不规则形式池（NLTK_EXTENSIONS 模式专用）。 */
const POOL: Record<string, string> = {
  sky: 'sky',
  skies: 'sky',
  dying: 'die',
  lying: 'lie',
  tying: 'tie',
  news: 'news',
  innings: 'inning',
  inning: 'inning',
  outings: 'outing',
  outing: 'outing',
  cannings: 'canning',
  canning: 'canning',
  howe: 'howe',
  proceed: 'proceed',
  exceed: 'exceed',
  succeed: 'succeed',
};

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);

function isConsonant(word: string, i: number): boolean {
  const c = word[i];
  if (VOWELS.has(c)) return false;
  if (c === 'y') {
    // y 是不是辅音取决于前一个字母，y 串迭代取反（与 NLTK 的循环实现等价）
    let negate = false;
    while (i > 0 && word[i] === 'y') {
      negate = !negate;
      i--;
    }
    return (i < 0 || !VOWELS.has(word[i])) !== negate;
  }
  return true;
}

/** m = [C](VC)^m[V] 的 VC 段数（'vc' 相邻对计数；结尾悬空元音不计）。 */
function measure(stem: string): number {
  let m = 0;
  let inVowel = false;
  for (let i = 0; i < stem.length; i++) {
    if (!isConsonant(stem, i)) {
      inVowel = true;
    } else if (inVowel) {
      m++;
      inVowel = false;
    }
  }
  return m;
}

function containsVowel(stem: string): boolean {
  for (let i = 0; i < stem.length; i++) if (!isConsonant(stem, i)) return true;
  return false;
}

function endsDoubleConsonant(word: string): boolean {
  const n = word.length;
  return n >= 2 && word[n - 1] === word[n - 2] && isConsonant(word, n - 1);
}

/** *o：结尾 cvc 且末位非 w/x/y；NLTK 扩展把两字符「元音+辅音」也算 cvc。 */
function endsCvc(word: string): boolean {
  const n = word.length;
  if (n >= 3) {
    return (
      isConsonant(word, n - 3) &&
      !isConsonant(word, n - 2) &&
      isConsonant(word, n - 1) &&
      !'wxy'.includes(word[n - 1])
    );
  }
  return n === 2 && !isConsonant(word, 0) && isConsonant(word, 1);
}

interface Rule {
  suffix: string;
  replacement: string;
  condition?: (stem: string, word: string) => boolean;
}

/** NLTK _apply_rule_list 语义：按列表序找**首个**后缀命中的规则（条件不满足也终止，不再试后续）。 */
function applyRules(word: string, rules: Rule[]): string {
  for (const r of rules) {
    if (r.suffix === '*d') {
      if (!endsDoubleConsonant(word)) continue;
      const stem = word.slice(0, -2);
      if (!r.condition || r.condition(stem, word)) return stem + r.replacement;
      return word;
    }
    if (!word.endsWith(r.suffix)) continue;
    const stem = r.suffix === '' ? word : word.slice(0, -r.suffix.length);
    if (!r.condition || r.condition(stem, word)) return stem + r.replacement;
    return word;
  }
  return word;
}

const step1a = (w: string): string => {
  if (w.endsWith('ies') && w.length === 4) return w.slice(0, -3) + 'ie';
  return applyRules(w, [
    { suffix: 'sses', replacement: 'ss' },
    { suffix: 'ies', replacement: 'i' },
    { suffix: 'ss', replacement: 'ss' },
    { suffix: 's', replacement: '' },
  ]);
};

const step1b = (w: string): string => {
  if (w.endsWith('ied')) {
    return w.length === 4 ? w.slice(0, -3) + 'ie' : w.slice(0, -3) + 'i';
  }
  if (w.endsWith('eed')) {
    const stem = w.slice(0, -3);
    return measure(stem) > 0 ? stem + 'ee' : w;
  }
  let intermediate = '';
  let succeeded = false;
  for (const suffix of ['ed', 'ing']) {
    if (w.endsWith(suffix)) {
      const stripped = w.slice(0, -suffix.length);
      if (containsVowel(stripped)) {
        intermediate = stripped;
        succeeded = true;
        break;
      }
    }
  }
  if (!succeeded) return w;
  const stem0 = intermediate;
  return applyRules(stem0, [
    { suffix: 'at', replacement: 'ate' },
    { suffix: 'bl', replacement: 'ble' },
    { suffix: 'iz', replacement: 'ize' },
    { suffix: '*d', replacement: stem0.slice(-1), condition: _ => !'lsz'.includes(stem0.slice(-1)) },
    { suffix: '', replacement: 'e', condition: stem => measure(stem) === 1 && endsCvc(stem) },
  ]);
};

const step1c = (w: string): string =>
  applyRules(w, [
    {
      suffix: 'y',
      replacement: 'i',
      condition: stem => stem.length > 1 && isConsonant(stem, stem.length - 1),
    },
  ]);

const step2 = (w: string): string => {
  // alli 先行：命中且 m>0 则换成 …al 后**递归**再过一遍 step2
  if (w.endsWith('alli') && measure(w.slice(0, -4)) > 0) {
    return step2(w.slice(0, -4) + 'al');
  }
  const mPos = (s: string) => measure(s) > 0;
  return applyRules(w, [
    { suffix: 'ational', replacement: 'ate', condition: mPos },
    { suffix: 'tional', replacement: 'tion', condition: mPos },
    { suffix: 'enci', replacement: 'ence', condition: mPos },
    { suffix: 'anci', replacement: 'ance', condition: mPos },
    { suffix: 'izer', replacement: 'ize', condition: mPos },
    { suffix: 'bli', replacement: 'ble', condition: mPos },
    { suffix: 'alli', replacement: 'al', condition: mPos },
    { suffix: 'entli', replacement: 'ent', condition: mPos },
    { suffix: 'eli', replacement: 'e', condition: mPos },
    { suffix: 'ousli', replacement: 'ous', condition: mPos },
    { suffix: 'ization', replacement: 'ize', condition: mPos },
    { suffix: 'ation', replacement: 'ate', condition: mPos },
    { suffix: 'ator', replacement: 'ate', condition: mPos },
    { suffix: 'alism', replacement: 'al', condition: mPos },
    { suffix: 'iveness', replacement: 'ive', condition: mPos },
    { suffix: 'fulness', replacement: 'ful', condition: mPos },
    { suffix: 'ousness', replacement: 'ous', condition: mPos },
    { suffix: 'aliti', replacement: 'al', condition: mPos },
    { suffix: 'iviti', replacement: 'ive', condition: mPos },
    { suffix: 'biliti', replacement: 'ble', condition: mPos },
    { suffix: 'fulli', replacement: 'ful', condition: mPos },
    // logi：l 归 stem —— 条件量的是 word[:-3]（含那个 l）
    { suffix: 'logi', replacement: 'log', condition: (_, word) => measure(word.slice(0, -3)) > 0 },
  ]);
};

const step3 = (w: string): string => {
  const mPos = (s: string) => measure(s) > 0;
  return applyRules(w, [
    { suffix: 'icate', replacement: 'ic', condition: mPos },
    { suffix: 'ative', replacement: '', condition: mPos },
    { suffix: 'alize', replacement: 'al', condition: mPos },
    { suffix: 'iciti', replacement: 'ic', condition: mPos },
    { suffix: 'ical', replacement: 'ic', condition: mPos },
    { suffix: 'ful', replacement: '', condition: mPos },
    { suffix: 'ness', replacement: '', condition: mPos },
  ]);
};

const step4 = (w: string): string => {
  const mGt1 = (s: string) => measure(s) > 1;
  return applyRules(w, [
    { suffix: 'al', replacement: '', condition: mGt1 },
    { suffix: 'ance', replacement: '', condition: mGt1 },
    { suffix: 'ence', replacement: '', condition: mGt1 },
    { suffix: 'er', replacement: '', condition: mGt1 },
    { suffix: 'ic', replacement: '', condition: mGt1 },
    { suffix: 'able', replacement: '', condition: mGt1 },
    { suffix: 'ible', replacement: '', condition: mGt1 },
    { suffix: 'ant', replacement: '', condition: mGt1 },
    { suffix: 'ement', replacement: '', condition: mGt1 },
    { suffix: 'ment', replacement: '', condition: mGt1 },
    { suffix: 'ent', replacement: '', condition: mGt1 },
    { suffix: 'ion', replacement: '', condition: s => measure(s) > 1 && /[st]$/.test(s) },
    { suffix: 'ou', replacement: '', condition: mGt1 },
    { suffix: 'ism', replacement: '', condition: mGt1 },
    { suffix: 'ate', replacement: '', condition: mGt1 },
    { suffix: 'iti', replacement: '', condition: mGt1 },
    { suffix: 'ous', replacement: '', condition: mGt1 },
    { suffix: 'ive', replacement: '', condition: mGt1 },
    { suffix: 'ize', replacement: '', condition: mGt1 },
  ]);
};

const step5a = (w: string): string => {
  if (!w.endsWith('e')) return w;
  const stem = w.slice(0, -1);
  if (measure(stem) > 1) return stem;
  if (measure(stem) === 1 && !endsCvc(stem)) return stem;
  return w;
};

const step5b = (w: string): string =>
  applyRules(w, [{ suffix: 'll', replacement: 'l', condition: (_, word) => measure(word.slice(0, -1)) > 1 }]);

export function stem(word: string): string {
  if (POOL[word] !== undefined) return POOL[word];
  if (word.length <= 2) return word;
  let w = word;
  w = step1a(w);
  w = step1b(w);
  w = step1c(w);
  w = step2(w);
  w = step3(w);
  w = step4(w);
  w = step5a(w);
  w = step5b(w);
  return w;
}
