const serverless = require('serverless-http');
const app = require('../../server');

// `binary` is what makes GET /photos/:email work in production. Lambda-style
// responses are strings, and serverless-http only base64-encodes the ones it
// considers binary — by default nothing, so an uploaded avatar would be run
// through toString('utf8') and arrive corrupted. Incoming bodies need no such
// setting: the request decoder already honours `isBase64Encoded`.
const handler = serverless(app, { binary: ['image/*'] });

exports.handler = (event, context) => {
  // Keep the pg pool alive between invocations instead of waiting for the
  // event loop to drain (which would hang on the open Postgres connections).
  context.callbackWaitsForEmptyEventLoop = false;
  return handler(event, context);
};
