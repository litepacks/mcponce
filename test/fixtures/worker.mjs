import { createMcpServer } from '../../dist/index.js';

const dataDir = process.argv[2];

const app = createMcpServer({
  name: 'concurrent-app',
  dataDir,
  port: 0
});

async function main() {
  const result = await app.start();
  if (process.send) {
    process.send(result);
  }

  process.on('message', async (msg) => {
    if (msg === 'exit') {
      await app.stop();
      process.exit(0);
    }
  });

  setTimeout(async () => {
    await app.stop();
    process.exit(0);
  }, 10000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
