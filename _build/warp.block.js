// ---- warp bootstrap ----------------------------------------------------

let WGCF_PATH = env.WGCF_PATH ? path.resolve(env.WGCF_PATH) : path.join(ASSET_DIR, 'wgcf');

async function ensureTemplateAssets() {
  WGCF_PATH = await ensureAsset('wgcf', `${ASSETS_BASE_URL}/wgcf`, true);
}

function parseIni(text) {
  const out = {};
  let cur = '';
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) {
      cur = sec[1].trim().toLowerCase();
      out[cur] = out[cur] || {};
      continue;
    }
    const idx = line.indexOf('=');
    if (idx < 0 || !cur) continue;
    out[cur][line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return out;
}

function wgcfToSingbox(text) {
  const ini = parseIni(text);
  const iface = ini.interface || {};
  const peer = ini.peer || {};
  const privateKey = iface.privatekey;
  const publicKey = peer.publickey;
  if (!privateKey || !publicKey) throw new Error('wgcf profile missing PrivateKey/PublicKey');

  const addresses = String(iface.address || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (addresses.length === 0) throw new Error('wgcf profile missing Address');

  const mtu = Number(iface.mtu || 1280) || 1280;
  const endpoint = String(peer.endpoint || 'engage.cloudflareclient.com:2408');
  const m = endpoint.match(/^\[?([^\]]+?)\]?:(\d+)$/);
  const host = m ? m[1] : endpoint;
  const port = m ? Number(m[2]) : 2408;
  const allowed = String(peer.allowedips || '0.0.0.0/0,::/0')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const wireguard = {
    type: 'wireguard',
    tag: 'warp',
    system: false,
    address: addresses,
    private_key: privateKey,
    peers: [{
      address: host,
      port,
      public_key: publicKey,
      allowed_ips: allowed,
      persistent_keepalive_interval: 25,
    }],
    mtu,
  };

  const reservedRaw = String(env.WARP_RESERVED || peer.reserved || '').trim();
  if (reservedRaw) {
    const reserved = reservedRaw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n));
    if (reserved.length === 3) wireguard.reserved = reserved;
  }

  return {
    log: { level: 'info' },
    endpoints: [wireguard],
    inbounds: [{ type: 'mixed', tag: 'in', listen: '127.0.0.1', listen_port: EGRESS_PORT }],
    outbounds: [{ type: 'direct', tag: 'direct' }],
    route: { final: 'warp' },
  };
}

async function prepareWarp() {
  await ensureTemplateAssets();
  const account = path.join(LOG_DIR, 'wgcf-account.toml');
  const profile = path.join(LOG_DIR, 'wgcf-profile.conf');
  await fsp.rm(account, { force: true });
  await fsp.rm(profile, { force: true });

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

  const text = await fsp.readFile(profile, 'utf8');
  const cfg = wgcfToSingbox(text);
  await fsp.writeFile(path.join(LOG_DIR, 'sb.json'), JSON.stringify(cfg, null, 2));
  log('WARP profile generated');
}

async function bootstrapEgress() {
  await prepareWarp();
  await startSingbox();
  if (!(await waitTcp(EGRESS_PORT, 30000))) throw new Error('sing-box did not listen');
  if (!(await verifyEgress(60000))) throw new Error('egress check failed');
}

async function rotateEgress() {
  await prepareWarp();
  await startSingbox();
  if (!(await waitTcp(EGRESS_PORT, 30000))) throw new Error('sing-box did not listen');
}
