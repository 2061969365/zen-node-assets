'use strict';

const fs = require('fs');
const path = require('path');

const core = fs.readFileSync(path.join(__dirname, 'core.js'), 'utf8');
const update = fs.readFileSync(path.join(__dirname, 'update.block.js'), 'utf8');

const targets = [
  { template: 'vpngate', nodeId: 'vpngate-1', fallback: 'true', block: 'vpngate.block.js' },
  { template: 'warp', nodeId: 'warp-1', fallback: 'false', block: 'warp.block.js' },
];

for (const t of targets) {
  const block = fs.readFileSync(path.join(__dirname, t.block), 'utf8');
  const out = core
    .replace(/__TEMPLATE__/g, t.template)
    .replace(/__NODE_ID__/g, t.nodeId)
    .replace(/__ALLOW_FALLBACK__/g, t.fallback)
    .replace('// __UPDATE_BLOCK__', () => update)
    .replace('// __TEMPLATE_BLOCK__', () => block);
  const dir = path.join(__dirname, '..', t.template);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'index.js');
  fs.writeFileSync(file, out);
  console.log('wrote', file, out.length);
}
