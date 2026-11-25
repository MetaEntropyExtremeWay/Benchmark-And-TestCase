import { defineConfig } from 'vitest/config';

// backup/ 是工程镜像备份（回滚用），不是测试源——排除避免 backup/test/*.test.ts 被当用例跑
// （其相对导入 ../src 指向 backup/src，必炸）。
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', 'backup/**'],
  },
});
