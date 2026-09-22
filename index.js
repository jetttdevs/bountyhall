import { createApp } from './src/server.js';

const port = Number(process.env.PORT || 3000);
const { server } = createApp();
server.listen(port, () => console.log(`bountyhall listening on http://localhost:${port}`));

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
