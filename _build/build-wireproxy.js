'use strict';

const fs = require('fs');
const path = require('path');

const core = fs.readFileSync(path.join(__dirname, 'core-wireproxy.js'), 'utf8');
const block = fs.readFileSync(path.join(__dirname, 'wireproxy.block.js'), 'utf8');
const update = fs.readFileSync(path.join(__dirname, 'update.block.js'), 'utf8');
const out = core
  .replace(/__TEMPLATE__/g, 'warp-wireproxy')
  .replace(/__NODE_ID__/g, 'warp-wireproxy-1')
  .replace(/__ALLOW_FALLBACK__/g, 'false')
  .replace('// __UPDATE_BLOCK__', () => update)
  .replace('// __TEMPLATE_BLOCK__', () => block);

const dir = path.join(__dirname, '..', 'warp-wireproxy');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'index.js');
fs.writeFileSync(file, out);
console.log('wrote', file, out.length);
