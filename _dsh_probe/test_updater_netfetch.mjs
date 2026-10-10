/**
 * 探针：验证 updater 在 Electron 主进程里用 net.fetch 能否拉到 GitHub
 * （模拟用户开着 Watt Toolkit hosts 反代加速器的真实环境）
 */
import { app } from 'electron';
import { checkUpdate } from '../host/updater.mjs';

app.whenReady().then(async () => {
  try {
    const r = await checkUpdate();
    console.log('CHECK_OK', JSON.stringify({
      current: r.current, latest: r.latest, hasUpdate: r.hasUpdate, files: r.files.length,
    }));
    app.exit(0);
  } catch (e) {
    console.log('CHECK_FAIL', e.message, e.cause ? String(e.cause) : '');
    app.exit(1);
  }
});
setTimeout(() => { console.log('TIMEOUT_45S'); app.exit(2); }, 45000);
