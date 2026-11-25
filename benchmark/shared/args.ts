/** harness CLI 共用的手动参数解析（无 cac 依赖；--key value / --key=value / --flag 形）。 */
export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const body = a.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      // 等号式：PS + npm 层会拆坏 --key value（旗标名被剥、只剩值落成位置参数），
      // 等号式单 token 存活——经 npm script 发参数一律用等号式
      out[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[body] = next;
      i++;
    } else {
      out[body] = 'true';
    }
  }
  return out;
}
