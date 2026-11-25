/**
 * 瞬态文件锁重试：Windows 上 Defender / 索引器会瞬时锁 rename 目标（EPERM / EACCES /
 * EBUSY），未捕获即进程崩退。锁是瞬态的：短退避重试，耗尽仍抛。
 */

const TRANSIENT_LOCK_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** 瞬态文件锁重试（同步退避，Atomics.wait——save() 是同步路径）。 */
export function retryOnTransientLock(fn: () => void, attempts = 5): void {
  for (let i = 1; ; i++) {
    try {
      fn();
      return;
    } catch (err) {
      if (!TRANSIENT_LOCK_CODES.has((err as NodeJS.ErrnoException).code ?? '') || i >= attempts) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * i);
    }
  }
}
