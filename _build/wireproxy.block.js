// ---- wireproxy (userspace WireGuard) bootstrap -------------------------

let WGCF_PATH = env.WGCF_PATH ? path.resolve(env.WGCF_PATH) : path.join(ASSET_DIR, 'wgcf');

async function ensureTemplateAssets() {
  WIREPROXY_PATH = await ensureAsset('wireproxy', `${ASSETS_BASE_URL}/wireproxy`, true);
  WGCF_PATH = await ensureAsset('wgcf', `${ASSETS_BASE_URL}/wgcf`, true);
}

function buildWireproxyConfig(profileText) {
  const lines = String(profileText).split(/\r?\n/);
  const out = [];
  const endpoint = env.WARP_ENDPOINT || '162.159.192.1:2408';
  let section = '';
  let hasKeepalive = false;
  let hasAllowed = false;

  for (const raw of lines) {
    const line = raw.trim();
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) {
      if (section === '[peer]' && !hasKeepalive) out.push('PersistentKeepalive = 25');
      section = `[${sec[1].trim().toLowerCase()}]`;
      hasKeepalive = false;
      hasAllowed = false;
      out.push(`[${sec[1].trim()}]`);
      continue;
    }
    if (!line || line.startsWith('#') || line.startsWith(';')) {
      out.push(raw);
      continue;
    }
    const idx = line.indexOf('=');
    if (idx < 0) {
      out.push(raw);
      continue;
    }
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (section === '[interface]') {
      if (key === 'address') {
        const addrs = value.split(',').map((s) => s.trim()).filter(Boolean);
        const v4 = addrs.find((s) => s.includes('.') && !s.includes(':'));
        const v6 = addrs.find((s) => s.includes(':'));
        if (!v4 && !v6) throw new Error('wgcf profile has no Address');
        if (v4) out.push(`Address = ${v4}`);
        if (v6) out.push(`Address = ${v6}`);
        continue;
      }
      if (key === 'dns') {
        out.push(`DNS = ${env.WARP_DNS || '1.1.1.1'}`);
        continue;
      }
    }

    if (section === '[peer]') {
      if (key === 'endpoint') {
        out.push(`Endpoint = ${endpoint}`);
        continue;
      }
      if (key === 'allowedips') {
        out.push('AllowedIPs = 0.0.0.0/0, ::/0');
        hasAllowed = true;
        continue;
      }
      if (key === 'persistentkeepalive') {
        hasKeepalive = true;
      }
    }

    out.push(raw);
  }

  if (section === '[peer]') {
    if (!hasAllowed) out.push('AllowedIPs = 0.0.0.0/0, ::/0');
    if (!hasKeepalive) out.push('PersistentKeepalive = 25');
  }

  return `${out.join('\n').trimEnd()}\n\n[http]\nBindAddress = 127.0.0.1:${EGRESS_PORT}\n`;
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
  const config = buildWireproxyConfig(profileText);
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
