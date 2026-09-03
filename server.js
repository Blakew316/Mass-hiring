// Local / VPS entry point. (On Netlify the same app runs as a function —
// see netlify/functions/api.js.)
const app = require('./app');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Hiring CRM running → http://localhost:${PORT}`);
});
