// Generated from executable examples and real adapter calls during docs:build.
const fs = require('node:fs');
module.exports = () => JSON.parse(fs.readFileSync('docs/_generated/home-demo.json', 'utf8'));
