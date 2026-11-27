// Self-update: stage a new index.js, verify it, atomically replace, restart.
// Protocol (Bearer NODE_TOKEN):
//   POST /_zen/node/v1/update   {template,version,sha256,content|url,restart,restartMode}
//   POST /_zen/node/v1/rollback {restart}

const UPDATE_MAX_BYTES = 1024 * 1024;
const UPDATE_BODY_LIMIT = 2 * 1024 * 1024;

const SCRIPT_PATH = (() => {
  try {
    const p = process.argv[1];
    if (!p) return '';
    return fs.realpathSync(path.resolve(p));
  } catch {
    return '';
  }
})();

function updateRestartMode() {
  const explicit = String(env.ZEN_UPDATE_RESTART_MODE || '').toLowerCase();
  if (explicit === 'exec' || explicit === 'exit' || explicit === 'crash') return explicit;
  // Cloud hosts restart the service on a clean exit.
  if (env.RENDER || env.RAILWAY_ENVIRONMENT || env.KOYEB_APP || env.FLY_APP_NAME || env.ZEABUR) {
    return 'exit';
  }
  // Pterodactyl/KataBump only restarts a non-zero exit; spawning a child would
  // be killed when the panel stops the container, so use a controlled crash.
  if (env.SERVER_PORT || env.P_SERVER_PORT || env.KATABUMP_PORT) {
    return 'crash';
  }
  return 'exec';
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function reEscape(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function closeServer(timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const fin = () => {
      if (done) return;
      done = true;
      resolve();
    };
    try { server.close(fin); } catch { fin(); }
    if (typeof server.closeAllConnections === 'function') {
      try { server.closeAllConnections(); } catch {}
    }
    setTimeout(fin, timeoutMs);
  });
}

async function checkScript(buf) {
  const tmp = `${SCRIPT_PATH}.check-${process.pid}.js`;
  await fsp.writeFile(tmp, buf, { mode: 0o755 });
  try {
    await new Promise((resolve, reject) => {
      const ch = spawn(process.execPath, ['--check', tmp], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      ch.stderr.setEncoding('utf8');
      ch.stderr.on('data', (c) => { err += c; });
      const timer = setTimeout(() => {
        try { ch.kill('SIGKILL'); } catch {}
        reject(new Error('syntax check timeout'));
      }, 10000);
      ch.on('error', (e) => { clearTimeout(timer); reject(e); });
      ch.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error('syntax check failed: ' + err.trim().slice(0, 300)));
      });
    });
  } finally {
    await fsp.unlink(tmp).catch(() => {});
  }
}

async function readUpdatePayload(body) {
  let buf;
  if (body.content != null) {
    const s = String(body.content).replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) {
      throw new Error('content is not valid base64');
    }
    buf = Buffer.from(s, 'base64');
  } else if (body.url) {
    let u;
    try { u = new URL(String(body.url)); } catch { throw new Error('bad url'); }
    const local = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
      throw new Error('update url must be https');
    }
    const r = await fetch(u.toString(), {
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
      headers: { 'user-agent': `zen-node/${VERSION}` },
    });
    if (!r.ok) throw new Error(`download status ${r.status}`);
    const len = Number(r.headers.get('content-length') || 0);
    if (len > UPDATE_MAX_BYTES) throw new Error('update too large');
    buf = Buffer.from(await r.arrayBuffer());
  } else {
    throw new Error('content or url required');
  }
  if (buf.length < 1000 || buf.length > UPDATE_MAX_BYTES) {
    throw new Error(`update size ${buf.length} out of range`);
  }
  return buf;
}

function scheduleRestart(mode) {
  if (state.restarting) return;
  state.restarting = true;
  const timer = setTimeout(() => {
    doRestart(mode).catch((e) => {
      log('self-update restart failed:', e.message);
      state.restarting = false;
    });
  }, 300);
  timer.unref();
}

async function doRestart(mode) {
  log(`self-update restart (${mode})`);
  try { await stopAll(); } catch {}
  await closeServer(mode === 'exec' ? 5000 : 3000);
  if (mode === 'exit') {
    process.exit(0);
  }
  if (mode === 'crash') {
    // Panel supervisors (Pterodactyl/KataBump) restart non-zero exits.
    process.exit(1);
  }
  const child = spawn(process.execPath, [SCRIPT_PATH], {
    detached: true,
    stdio: 'inherit',
    cwd: process.cwd(),
    env: process.env,
  });
  child.unref();
  setTimeout(() => process.exit(0), 200);
}

async function handleUpdate(req, res) {
  if (state.updating || state.restarting) return json(res, 409, { error: 'update already in progress' });
  if (!SCRIPT_PATH || !SCRIPT_PATH.endsWith('.js')) {
    return json(res, 409, { error: 'script path unavailable; start with node /path/to/index.js' });
  }
  const body = await readJson(req, UPDATE_BODY_LIMIT);
  if (!body || typeof body !== 'object') return json(res, 400, { error: 'bad json' });

  const targetVersion = String(body.version || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(targetVersion)) {
    return json(res, 400, { error: 'bad version' });
  }
  if (body.template != null && String(body.template) !== TEMPLATE) {
    return json(res, 400, { error: `template mismatch: expected ${TEMPLATE}` });
  }
  const sha = String(body.sha256 || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha)) return json(res, 400, { error: 'bad sha256' });
  const restart = body.restart !== false;
  const requestedMode = String(body.restartMode || '').toLowerCase();
  if (requestedMode && requestedMode !== 'exec' && requestedMode !== 'exit' && requestedMode !== 'crash') {
    return json(res, 400, { error: 'restartMode must be exec, exit or crash' });
  }

  state.updating = true;
  try {
    const buf = await readUpdatePayload(body);
    const got = sha256Hex(buf);
    if (got !== sha) return json(res, 400, { error: `sha256 mismatch: got ${got}` });
    const text = buf.toString('utf8');
    if (!new RegExp(`const\\s+TEMPLATE\\s*=\\s*['"]${reEscape(TEMPLATE)}['"]`).test(text)) {
      return json(res, 400, { error: 'template marker mismatch' });
    }
    if (!new RegExp(`const\\s+VERSION\\s*=\\s*['"]${reEscape(targetVersion)}['"]`).test(text)) {
      return json(res, 400, { error: 'version marker mismatch' });
    }
    await checkScript(buf);

    const bak = `${SCRIPT_PATH}.bak`;
    const tmp = `${SCRIPT_PATH}.new`;
    await fsp.copyFile(SCRIPT_PATH, bak);
    await fsp.writeFile(tmp, buf, { mode: 0o755 });
    await fsp.chmod(tmp, 0o755).catch(() => {});
    try {
      await fsp.rename(tmp, SCRIPT_PATH);
    } catch {
      await fsp.unlink(SCRIPT_PATH).catch(() => {});
      await fsp.rename(tmp, SCRIPT_PATH);
    }

    const mode = requestedMode || updateRestartMode();
    log(`self-update staged ${VERSION} -> ${targetVersion} sha=${got.slice(0, 12)} restart=${restart ? mode : 'no'}`);
    json(res, restart ? 202 : 200, {
      ok: true,
      from: VERSION,
      to: targetVersion,
      sha256: got,
      restart,
      restartMode: restart ? mode : 'none',
    });
    if (restart) scheduleRestart(mode);
  } catch (e) {
    json(res, 400, { error: e.message });
  } finally {
    if (!state.restarting) state.updating = false;
  }
}

async function handleRollback(req, res) {
  if (state.updating || state.restarting) return json(res, 409, { error: 'update already in progress' });
  if (!SCRIPT_PATH || !SCRIPT_PATH.endsWith('.js')) {
    return json(res, 409, { error: 'script path unavailable' });
  }
  const bak = `${SCRIPT_PATH}.bak`;
  if (!fs.existsSync(bak)) return json(res, 404, { error: 'no backup' });
  const body = await readJson(req, 65536);
  const restart = !body || body.restart !== false;

  state.updating = true;
  try {
    const buf = await fsp.readFile(bak);
    await checkScript(buf);
    const tmp = `${SCRIPT_PATH}.new`;
    await fsp.writeFile(tmp, buf, { mode: 0o755 });
    await fsp.chmod(tmp, 0o755).catch(() => {});
    await fsp.rename(tmp, SCRIPT_PATH);
    const v = (buf.toString('utf8').match(/const\s+VERSION\s*=\s*['"]([^'"]+)['"]/) || [])[1] || '';
    log(`self-update rollback -> ${v || 'backup'} restart=${restart}`);
    json(res, restart ? 202 : 200, { ok: true, version: v, restart, restartMode: restart ? updateRestartMode() : 'none' });
    if (restart) scheduleRestart(updateRestartMode());
  } catch (e) {
    json(res, 400, { error: e.message });
  } finally {
    if (!state.restarting) state.updating = false;
  }
}
