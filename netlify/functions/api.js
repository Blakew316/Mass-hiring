// Netlify Function that serves the whole Express API. netlify.toml rewrites
// /api/*, /auth/* and /webhooks/* here; the static dashboard in public/ is
// served by Netlify's CDN directly.
const serverless = require('serverless-http');
const app = require('../../app');

const handler = serverless(app);

exports.handler = async (event, context) => {
  // Normalize direct function invocations (/.netlify/functions/api/...) to
  // the same paths Express routes on.
  if (event.path) {
    event.path = event.path.replace(/^\/\.netlify\/functions\/api/, '') || '/';
  }
  return handler(event, context);
};
