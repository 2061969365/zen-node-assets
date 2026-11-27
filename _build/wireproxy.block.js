// ---- wireproxy (userspace WireGuard) bootstrap -------------------------

let WGCF_PATH = env.WGCF_PATH ? path.resolve(env.WGCF_PATH) : path.join(ASSET_DIR, 'wgcf');

async function ensureTemplateAssets() {
  WIREPROXY_PATH = await ensureAsset('wireproxy', `${ASSETS_BASE_URL}/wireproxy`, true);
  WGCF_PATH = await ensureAsset('wgcf', `${ASSETS_BASE_URL}/wgcf`, true);
}

async function prepareWireproxy() {
  await ensureTemplateAssets();

  const account = path.join(LOG_DIR, 'wgcf-account.toml');
  const profile = path.join(LOG_DIR, 'wgcf-profile.conf');
  const cfg = path.join(LOG_DIR, 'wireproxy.conf');
  await fsp.rm(account, { force: true });
  await fsp.rm(profile, { force: true });
  await fsp.rm(cfg, { force: true });

  let code = await runCommand(WGCF_PATH, ['register', '--accept-tos'], {
    cwd: LOG_DIR,
    logFile: path.join(LOG_DIR, 'wgcf.log'),
    timeoutMs: 120000,
  });
  if (code !== 0) throw new Error(`wgcf register exited ${code}`);

  code = await runCommand(WGCF_PATH, ['generate'], {
    cwd: LOG_DIR,
    logFile: path.join(LOG_DIR, 'wgcf.log'),
    timeoutMs: 60000,
  });
  if (code !== 0) throw new Error(`wgcf generate exited ${code}`);

  const profileText = await fsp.readFile(profile, 'utf8');
  const config = `${profileText.trimEnd()}\n\n[http]\nBindAddress = 127.0.0.1:${EGRESS_PORT}\n`;
  await fsp.writeFile(cfg, config, { mode: 0o600 });

  code = await runCommand(WIREPROXY_PATH, ['-n', '-c', cfg], {
    cwd: LOG_DIR,
    logFile: path.join(LOG_DIR, 'wireproxy-configtest.log'),
    timeoutMs: 30000,
  });
  if (code !== 0) throw new Error(`wireproxy configtest exited ${code}`);

  log('WARP wireproxy config generated');
}

async function bootstrapEgress() {
  await prepareWireproxy();
  await startWireproxy();
  if (!(await waitTcp(EGRESS_PORT, 30000))) throw new Error('wireproxy did not listen');
  if (!(await verifyEgress(60000))) throw new Error('egress check failed');
}

async function rotateEgress() {
  await prepareWireproxy();
  if (state.singbox) {
    await state.singbox.stop();
    state.singbox = null;
  }
  await sleep(2000);
  await startWireproxy();
  if (!(await waitTcp(EGRESS_PORT, 30000))) throw new Error('wireproxy did not listen');
}
