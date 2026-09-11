#!/usr/bin/env node
'use strict';

// Plain CommonJS with no dependencies, so that it still runs on the versions
// of Node it exists to turn away. Anything that touches an ES module has to
// happen after this check.
const { MINIMUM_NODE, isSupportedNodeVersion } = require('../dist/nodeSupport.js');

if (!isSupportedNodeVersion(process.versions.node)) {
  console.error(
    `cosensecli needs Node ${MINIMUM_NODE} or newer, and this is ${process.version}.`,
  );
  console.error('The cosense CLI it runs declares the same floor.');
  process.exit(1);
}

require('../dist/index.js');
