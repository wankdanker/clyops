// Make require('clyops') load the committed single-file bundle, clyops.cjs,
// instead of the package build: the *-bundle.cjs demos run the conformance
// suite against it.
'use strict';
const Module = require('node:module');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === 'clyops' ? require.resolve('../clyops.cjs') : resolve.call(this, request, ...rest);
};
