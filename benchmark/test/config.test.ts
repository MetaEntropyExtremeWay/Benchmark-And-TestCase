/**
 * harness 配置纯函数测试：memUrl 跨域硬门。
 * 背景坑：.env 钉死单域坐标（如 8081）后直跑另一数据集，prepare 会把数据静默灌进
 * 别家库——assertMemUrl 把它变成带修法的即错。
 * 只测纯函数：loadHarnessEnv 含文件读，不在单测面。
 */
import { describe, expect, it } from 'vitest';
import { assertMemUrl, CANONICAL_MC_MEM_URL } from '../shared/config.ts';

describe('CANONICAL_MC_MEM_URL 规范坐标（mc 直测线）', () => {
  it('两数据集各占一个端口（撞端口是硬门的判据）', () => {
    expect(CANONICAL_MC_MEM_URL.lme).toBe('http://127.0.0.1:8081');
    expect(CANONICAL_MC_MEM_URL.locomo).toBe('http://127.0.0.1:8082');
  });
});

describe('assertMemUrl 跨域硬门', () => {
  it('撞别家规范端口即抛错，报错自带修法', () => {
    // .env 钉死 lme 坐标跑 locomo（实际踩过的形态）
    expect(() => assertMemUrl('locomo', 'http://127.0.0.1:8081')).toThrow(/lme 域 bench 实例的规范坐标/);
    expect(() => assertMemUrl('locomo', 'http://127.0.0.1:8081')).toThrow(/mem-bench-app\.ps1 start -Dataset locomo/);
    // 反向：钉死 locomo 坐标跑 lme
    expect(() => assertMemUrl('lme', 'http://127.0.0.1:8082')).toThrow(/locomo 域 bench 实例的规范坐标/);
  });

  it('本域规范坐标放行', () => {
    expect(() => assertMemUrl('lme', CANONICAL_MC_MEM_URL.lme)).not.toThrow();
    expect(() => assertMemUrl('locomo', CANONICAL_MC_MEM_URL.locomo)).not.toThrow();
  });

  it('自定义实例坐标放行（真起自定义实例的人知道自己在干什么）', () => {
    expect(() => assertMemUrl('lme', 'http://127.0.0.1:9099')).not.toThrow();
    expect(() => assertMemUrl('locomo', 'http://10.0.0.3:9000')).not.toThrow();
  });

  it('跨线门：mc 线驱动指链线实例规范口（8084/8085）即拦——链线库只收链线 formation 写入', () => {
    expect(() => assertMemUrl('lme', 'http://127.0.0.1:8084')).toThrow(/lmg:lme 域 bench 实例的规范坐标/);
    expect(() => assertMemUrl('lme', 'http://127.0.0.1:8085')).toThrow(/lmg:locomo 域/);
    expect(() => assertMemUrl('locomo', 'http://127.0.0.1:8085')).toThrow(/lmg:locomo 域/);
  });

  it('解析不了的 URL 不误杀（后续真调用会自己报错）', () => {
    expect(() => assertMemUrl('lme', 'not-a-url')).not.toThrow();
  });
});
