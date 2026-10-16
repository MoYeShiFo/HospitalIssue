// v1.18.52 验证：登录页标题固定为「软件问题登记系统」，不再显示 appName（医院名）。
import { findChromium, waitDevtools, startChrome, openPage, closePage, waitFor, evaluate, screenshot } from './_cdp.mjs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
if (!findChromium()) { console.log('SKIP: 无 chromium'); process.exit(0); }

const port = 9800 + (process.pid % 200);
const proc = startChrome({ port });
try {
  await waitDevtools(port);
  const page = await openPage(port, `${BASE}/`);
  await waitFor(page, `document.querySelector('.login-card h2')`, '登录卡片渲染', 10000);
  await new Promise((r) => setTimeout(r, 300));
  const info = await evaluate(page, `(() => ({
    h2: (document.querySelector('.login-card h2') || {}).textContent || '',
    title: document.title,
    hasLoginMask: !!document.querySelector('.login-mask'),
  }))()`);
  console.log('RESULT', JSON.stringify(info));
  await screenshot(page, 'login-v11852.png');
  await closePage(page);
} finally { proc.kill(); }
process.exit(0);
