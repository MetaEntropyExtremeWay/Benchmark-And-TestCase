/** 模块是否为进程入口——驱动件「跑不跑 main」的判别。
 *
 * 驱动件既要能 `npx tsx <文件>` 直跑，又要能被别的驱动 / 单测 import 纯函数面而不连带
 * 跑 main。老判别是「环境里没有 VITEST 就跑」：单测下成立，驱动 import 驱动时不成立
 * （被 import 方的 main 读到的是调用方的 argv，照着跑必错）。入口判别只认「本文件就是
 * 进程脚本」——被 import 一律不跑，谁调都安全；单测下 VITEST 判别继续兜着。
 *
 * @param moduleUrl 被判文件的 import.meta.url
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function isProcessEntry(moduleUrl: string): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    // 大小写不敏感：Windows 下盘符大小写在 argv[1] 与 import.meta.url 间不保证一致
    return pathToFileURL(path.resolve(script)).href.toLowerCase() === moduleUrl.toLowerCase();
  } catch {
    return false;
  }
}
