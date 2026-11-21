// Runs the Check-ins API on a PC: npm run dev -> http://localhost:3003
const app = require('./app');

const PORT = Number(process.env.PORT) || 3003;
app.listen(PORT, () => console.log(`Check-ins service on http://localhost:${PORT}`));
