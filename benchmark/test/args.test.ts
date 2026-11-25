/** parseArgs 三形态：--key value / --key=value（PS + npm 层唯一稳妥形态）/ --flag。 */
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../shared/args.ts';

describe('parseArgs', () => {
  it('空格式 --key value 与裸旗标', () => {
    expect(parseArgs(['--arm', 's', '--verbose'])).toEqual({ arm: 's', verbose: 'true' });
  });

  it('等号式（PS + npm 经手后唯一存活的形态）', () => {
    expect(parseArgs(['--dataset=lme', '--limit=3', '--run=p26-a3-iso'])).toEqual({
      dataset: 'lme',
      limit: '3',
      run: 'p26-a3-iso',
    });
  });

  it('等号式与空格式混用；值里含 = 只切第一个', () => {
    expect(parseArgs(['--run=a=b', '--limit', '3'])).toEqual({ run: 'a=b', limit: '3' });
  });

  it('位置参数忽略（旗标被剥后的残骸不致错读）', () => {
    expect(parseArgs(['lme', '3', 'p26-a3-iso'])).toEqual({});
  });
});
