// ---- vpngate bootstrap -------------------------------------------------

const PYTHON_BIN = env.PYTHON_BIN || 'python3';
const VPNGATE_CSV_URL = env.VPNGATE_CSV_URL || 'https://www.vpngate.net/api/iphone/';
// Pterodactyl/KataBump containers have a low thread/process limit; keep the
// probe pool small there. Override with VPNGATE_* when the host allows more.
const PANEL_HOST = !!(env.SERVER_PORT || env.P_SERVER_PORT || env.KATABUMP_PORT);
const VPNGATE_MAX_CANDIDATES = Math.max(1, Number(env.VPNGATE_MAX_CANDIDATES || (PANEL_HOST ? 10 : 35)));
const VPNGATE_CONCURRENCY = Math.max(1, Number(env.VPNGATE_CONCURRENCY || (PANEL_HOST ? 4 : 20)));
const VPNGATE_PHASE1_CONCURRENCY = Math.max(1, Number(env.VPNGATE_PHASE1_CONCURRENCY || (PANEL_HOST ? 12 : 50)));
const VPNGATE_KEEP_NODES = Math.max(1, Number(env.VPNGATE_KEEP_NODES || 3));

let vpngatePreflightDone = false;
let vpngateIdx = 0;
let vpngateBurned = new Set();

function vpngateKey(node) {
  return `${node.server}:${node.server_port}`;
}

function loadVpngateIdx() {
  for (const p of [path.join(LOG_DIR, 'vpngate.idx'), '/tmp/vpngate_current_idx.txt']) {
    try {
      const n = Number(fs.readFileSync(p, 'utf8').trim());
      if (Number.isInteger(n) && n >= 0) return n;
    } catch {}
  }
  return 0;
}

function saveVpngateIdx() {
  try { fs.writeFileSync(path.join(LOG_DIR, 'vpngate.idx'), String(vpngateIdx)); } catch {}
}

async function preflightVpngate() {
  if (vpngatePreflightDone) return;
  const py = await runCommand(PYTHON_BIN, ['--version'], {
    logFile: path.join(LOG_DIR, 'preflight.log'),
    timeoutMs: 10000,
  });
  if (py !== 0) throw new Error(`${PYTHON_BIN} is required for vpngate mode`);
  const curl = await runCommand('curl', ['--version'], {
    logFile: path.join(LOG_DIR, 'preflight.log'),
    timeoutMs: 10000,
  });
  if (curl !== 0) throw new Error('curl is required for vpngate mode');
  vpngatePreflightDone = true;
}

async function ensureTemplateAssets() {
  await ensureAsset('vpngate_to_singbox.py', `${ASSETS_BASE_URL}/vpngate_to_singbox.py`, false, SCRIPT_DIR);
  await ensureAsset('probe_and_select_vpngate.py', `${ASSETS_BASE_URL}/probe_and_select_vpngate.py`, false, SCRIPT_DIR);
}

async function applyVpngateDns(outPath) {
  try {
    const cfg = JSON.parse(await fsp.readFile(outPath, 'utf8'));
    const detour = (cfg.endpoints && cfg.endpoints[0] && cfg.endpoints[0].tag) || (cfg.route && cfg.route.final) || 'vpngate-active';
    cfg.dns = {
      servers: [{ type: 'https', tag: 'dns-remote', server: String(env.VPNGATE_DNS || '1.1.1.1'), detour }],
      final: 'dns-remote',
      strategy: 'prefer_ipv4',
    };
    await fsp.writeFile(outPath, JSON.stringify(cfg, null, 2));
  } catch (e) {
    log('vpngate dns inject failed:', e.message);
  }
}

async function runVpngateSelect() {
  await preflightVpngate();
  const csvPath = path.join(LOG_DIR, 'vpngate.csv');
  log('fetching VPNGate CSV');
  const csv = await fetchBuffer(VPNGATE_CSV_URL, 60000);
  await fsp.writeFile(csvPath, csv);
  log(`VPNGate CSV ${csv.length} bytes`);

  const outPath = path.join(LOG_DIR, 'sb.json');
  const args = [
    path.join(SCRIPT_DIR, 'probe_and_select_vpngate.py'),
    '--csv', csvPath,
    '--output', outPath,
    '--zen-bin', ZEN_DIRECT_PATH,
    '--singbox-bin', SINGBOX_PATH,
    '--concurrency', String(VPNGATE_CONCURRENCY),
    '--phase1-concurrency', String(VPNGATE_PHASE1_CONCURRENCY),
    '--max-candidates', String(VPNGATE_MAX_CANDIDATES),
    '--keep-nodes', String(VPNGATE_KEEP_NODES),
    '--mixed-port', String(EGRESS_PORT),
  ];
  log('selecting VPNGate nodes');
  const code = await runCommand(PYTHON_BIN, args, {
    cwd: SCRIPT_DIR,
    env: { ...process.env, PYTHONPATH: SCRIPT_DIR, PYTHONUNBUFFERED: '1' },
    logFile: path.join(LOG_DIR, 'vpngate-select.log'),
    timeoutMs: 15 * 60 * 1000,
  });
  if (code !== 0) throw new Error(`vpngate select exited ${code}`);
  if (!fs.existsSync(outPath)) throw new Error('vpngate select produced no sb.json');
  await applyVpngateDns(outPath);
  vpngateBurned.clear();
  vpngateIdx = 0;
  saveVpngateIdx();
  log(`VPNGate nodes selected, idx=${vpngateIdx}`);
}

async function bootstrapEgress() {
  await runVpngateSelect();
  await sleep(5000);
  await startSingbox();
  if (!(await waitTcp(EGRESS_PORT, 30000))) throw new Error('sing-box did not listen');
  if (!(await verifyEgress(60000))) throw new Error('egress check failed');
}

async function rotateVpngate(reason) {
  const verifiedPath = '/tmp/verified_nodes.json';
  if (!fs.existsSync(verifiedPath)) return false;
  let nodes;
  try {
    nodes = JSON.parse(await fsp.readFile(verifiedPath, 'utf8'));
  } catch {
    return false;
  }
  if (!Array.isArray(nodes) || nodes.length === 0) return false;

  if (reason === '429' || reason === 'egress') {
    const cur = nodes[vpngateIdx % nodes.length];
    if (cur) vpngateBurned.add(vpngateKey(cur));
  }

  let next = -1;
  for (let step = 1; step <= nodes.length; step++) {
    const idx = (vpngateIdx + step) % nodes.length;
    if (!vpngateBurned.has(vpngateKey(nodes[idx]))) {
      next = idx;
      break;
    }
  }
  if (next < 0) {
    log(`VPNGate all ${nodes.length} verified nodes burned, re-selecting`);
    vpngateBurned.clear();
    return false;
  }

  vpngateIdx = next;
  saveVpngateIdx();
  const node = nodes[vpngateIdx];
  const endpoint = { ...node.endpoint, tag: 'vpngate-active' };
  const cfg = {
    log: { level: 'info' },
    dns: {
      servers: [{ type: 'https', tag: 'dns-remote', server: String(env.VPNGATE_DNS || '1.1.1.1'), detour: 'vpngate-active' }],
      final: 'dns-remote',
      strategy: 'prefer_ipv4',
    },
    endpoints: [endpoint],
    outbounds: [{ type: 'direct', tag: 'direct' }],
    inbounds: [{ type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: EGRESS_PORT }],
    route: { final: 'vpngate-active' },
  };
  await fsp.writeFile(path.join(LOG_DIR, 'sb.json'), JSON.stringify(cfg, null, 2));
  if (state.singbox) {
    await state.singbox.stop();
    state.singbox = null;
  }
  await sleep(2000);
  await startSingbox();
  const ok = await waitTcp(EGRESS_PORT, 30000);
  log(`VPNGate switched to #${vpngateIdx} ${vpngateKey(node)} reason=${reason || 'manual'} ok=${ok}`);
  return ok;
}

async function rotateEgress(reason) {
  const ok = await rotateVpngate(reason);
  if (ok) return;
  log(`VPNGate pool exhausted (reason=${reason || 'manual'}), re-selecting fresh nodes`);
  vpngateBurned.clear();
  vpngateIdx = 0;
  await runVpngateSelect();
  await startSingbox();
  if (!(await waitTcp(EGRESS_PORT, 30000))) throw new Error('sing-box did not listen after reselect');
}
