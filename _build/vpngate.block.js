// ---- vpngate bootstrap -------------------------------------------------

const PYTHON_BIN = env.PYTHON_BIN || 'python3';
const VPNGATE_CSV_URL = env.VPNGATE_CSV_URL || 'https://www.vpngate.net/api/iphone/';
const VPNGATE_MAX_CANDIDATES = Math.max(1, Number(env.VPNGATE_MAX_CANDIDATES || 35));
const VPNGATE_CONCURRENCY = Math.max(1, Number(env.VPNGATE_CONCURRENCY || 20));
const VPNGATE_KEEP_NODES = Math.max(1, Number(env.VPNGATE_KEEP_NODES || 3));

let vpngatePreflightDone = false;
let vpngateIdx = 0;

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
  vpngateIdx = loadVpngateIdx();
  log(`VPNGate nodes selected, idx=${vpngateIdx}`);
}

async function bootstrapEgress() {
  await runVpngateSelect();
  await startSingbox();
  if (!(await waitTcp(EGRESS_PORT, 30000))) throw new Error('sing-box did not listen');
  if (!(await verifyEgress())) throw new Error('egress check failed');
}

async function rotateVpngate() {
  const verifiedPath = '/tmp/verified_nodes.json';
  if (!fs.existsSync(verifiedPath)) return false;
  let nodes;
  try {
    nodes = JSON.parse(await fsp.readFile(verifiedPath, 'utf8'));
  } catch {
    return false;
  }
  if (!Array.isArray(nodes) || nodes.length === 0) return false;

  vpngateIdx = (vpngateIdx + 1) % nodes.length;
  saveVpngateIdx();
  const node = nodes[vpngateIdx];
  const endpoint = { ...node.endpoint, tag: 'vpngate-active' };
  const cfg = {
    log: { level: 'info' },
    endpoints: [endpoint],
    outbounds: [{ type: 'direct', tag: 'direct' }],
    inbounds: [{ type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: EGRESS_PORT }],
    route: { final: 'vpngate-active' },
  };
  await fsp.writeFile(path.join(LOG_DIR, 'sb.json'), JSON.stringify(cfg, null, 2));
  await startSingbox();
  const ok = await waitTcp(EGRESS_PORT, 30000);
  log(`VPNGate switched to #${vpngateIdx} ${node.server}:${node.server_port} ok=${ok}`);
  return ok;
}

async function rotateEgress() {
  const ok = await rotateVpngate();
  if (ok) return;
  log('VPNGate rotate had no verified node, re-selecting');
  await runVpngateSelect();
  await startSingbox();
  if (!(await waitTcp(EGRESS_PORT, 30000))) throw new Error('sing-box did not listen after reselect');
}
