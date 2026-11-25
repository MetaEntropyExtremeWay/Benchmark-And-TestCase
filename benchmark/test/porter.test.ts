import { describe, expect, it } from 'vitest';
import { stem } from '../shared/porter.ts';

/**
 * 向量 = NLTK_EXTENSIONS 方言的**全管线**输出（不是 1980 论文的规则级示例——
 * 论文示例只演示单步规则，如 agreed→agree 只到 step1b，全管线还会过 step5a 得 agre）。
 * 实现已对 NLTK 官方 porter 测试词表（23531 词）全量对拍 100% 一致；下面是各步
 * 特性的锚点回归 + 方言特例。
 */
describe('porter stemmer（NLTK_EXTENSIONS 方言）', () => {
  it('step 1a + 4 字母 ies 特例', () => {
    expect(stem('caresses')).toBe('caress');
    expect(stem('ponies')).toBe('poni');
    expect(stem('ties')).toBe('tie'); // NLTK 特例：4 字母 ies→ie
    expect(stem('caress')).toBe('caress');
    expect(stem('cats')).toBe('cat');
  });

  it('step 1b（含 ed/ing 命中后的收尾修复）', () => {
    expect(stem('feed')).toBe('feed');
    expect(stem('agreed')).toBe('agre'); // eed→ee 后 step5a 再去 e（论文示例止步 step1b 的 agree）
    expect(stem('plastered')).toBe('plaster');
    expect(stem('bled')).toBe('bled');
    expect(stem('motoring')).toBe('motor');
    expect(stem('sing')).toBe('sing');
    expect(stem('conflated')).toBe('conflat');
    expect(stem('troubled')).toBe('troubl');
    expect(stem('sized')).toBe('size');
    expect(stem('hopping')).toBe('hop');
    expect(stem('tanned')).toBe('tan');
    expect(stem('falling')).toBe('fall');
    expect(stem('hissing')).toBe('hiss');
    expect(stem('fizzed')).toBe('fizz');
    expect(stem('failing')).toBe('fail');
    expect(stem('filing')).toBe('file');
  });

  it('step 1c：y 前是辅音才变 i（NLTK 特例）', () => {
    expect(stem('happy')).toBe('happi');
    expect(stem('enjoy')).toBe('enjoy'); // y 前是元音 → 不动
    expect(stem('sky')).toBe('sky'); // 不规则池
  });

  it('step 2', () => {
    expect(stem('relational')).toBe('relat');
    expect(stem('conditional')).toBe('condit');
    // 论文示例是 rational→rational，但 NLTK 方言里 step2 ational 命中后条件 m("r")=0
    // 不满足即**终止**（不再试后续规则），到 step4 时 'al' 因 m("ration")=2 被剥 → ration
    expect(stem('rational')).toBe('ration');
    expect(stem('valenci')).toBe('valenc');
    expect(stem('hesitanci')).toBe('hesit');
    expect(stem('digitizer')).toBe('digit');
    expect(stem('conformabli')).toBe('conform');
    expect(stem('radicalli')).toBe('radic');
    expect(stem('differentli')).toBe('differ');
    expect(stem('vileli')).toBe('vile');
    expect(stem('analogousli')).toBe('analog');
    expect(stem('vietnamization')).toBe('vietnam');
    expect(stem('predication')).toBe('predic');
    expect(stem('operator')).toBe('oper');
    expect(stem('feudalism')).toBe('feudal');
    expect(stem('decisiveness')).toBe('decis');
    expect(stem('hopefulness')).toBe('hope');
    expect(stem('callousness')).toBe('callous');
    expect(stem('formaliti')).toBe('formal');
    expect(stem('sensitiviti')).toBe('sensit');
    expect(stem('sensibiliti')).toBe('sensibl');
  });

  it('step 2 NLTK 追加规则（bli/fulli/logi）', () => {
    expect(stem('abilities')).toBe('abil');
    expect(stem('apology')).toBe('apolog'); // logi→log
    expect(stem('geology')).toBe('geolog');
    expect(stem('archaeology')).toBe('archaeolog');
  });

  it('step 3', () => {
    expect(stem('triplicate')).toBe('triplic');
    expect(stem('formative')).toBe('form');
    expect(stem('formalize')).toBe('formal');
    expect(stem('electriciti')).toBe('electr');
    expect(stem('electrical')).toBe('electr');
    expect(stem('hopeful')).toBe('hope');
    expect(stem('goodness')).toBe('good');
  });

  it('step 4', () => {
    expect(stem('revival')).toBe('reviv');
    expect(stem('allowance')).toBe('allow');
    expect(stem('inference')).toBe('infer');
    expect(stem('airliner')).toBe('airlin');
    expect(stem('gyroscopic')).toBe('gyroscop');
    expect(stem('adjustable')).toBe('adjust');
    expect(stem('defensible')).toBe('defens');
    expect(stem('irritant')).toBe('irrit');
    expect(stem('replacement')).toBe('replac');
    expect(stem('adjustment')).toBe('adjust');
    expect(stem('dependent')).toBe('depend');
    expect(stem('adoption')).toBe('adopt');
    expect(stem('communism')).toBe('commun');
    expect(stem('activate')).toBe('activ');
    expect(stem('angular')).toBe('angular');
    expect(stem('homologous')).toBe('homolog');
    expect(stem('effective')).toBe('effect');
    expect(stem('bowdlerize')).toBe('bowdler');
  });

  it('step 5 + 两字符 cvc 扩展', () => {
    expect(stem('probate')).toBe('probat');
    expect(stem('rate')).toBe('rate');
    expect(stem('cease')).toBe('ceas');
    expect(stem('controll')).toBe('control');
    expect(stem('roll')).toBe('roll');
    expect(stem('ace')).toBe('ace'); // 两字符「元音+辅音」结尾算 cvc → 保留 e
    expect(stem('abed')).toBe('abe');
  });

  it('不规则池与短词', () => {
    expect(stem('dying')).toBe('die');
    expect(stem('lying')).toBe('lie');
    expect(stem('tying')).toBe('tie');
    expect(stem('news')).toBe('news');
    expect(stem('proceed')).toBe('proceed');
    expect(stem('agreement')).toBe('agreement'); // m(…)=1 不足以剥 ement
    expect(stem('is')).toBe('is'); // ≤2 字母不动
    expect(stem('a')).toBe('a');
  });

  it('F1 常用词', () => {
    expect(stem('playing')).toBe('play');
    expect(stem('pianos')).toBe('piano');
    expect(stem('seventy')).toBe('seventi');
  });
});
