import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpServer } from '../../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const quickstartPath = path.join(__dirname, '../quickstart/server.ts');

// Programmatic control example (Method 4)
async function main() {
  console.log('=== mcponce Programmatic Background Example ===\n');

  // 1. Initialize server pointing to quickstart server script
  const app = createMcpServer({
    name: 'quick-mcp',
    entrypoint: quickstartPath
  });

  // 2. Start server in background with Unitup
  console.log('1. Starting shared server in background with app.start({ background: true })...');
  const startResult = await app.start({ background: true });
  console.log(`   Started! PID: ${startResult.pid}, Port: ${startResult.port}, Role: ${startResult.role}\n`);

  // 3. Inspect runtime status programmatically
  console.log('2. Querying status with app.status()...');
  const status = await app.status();
  console.log(`   Status: ${status.status}, Active sessions: ${status.activeSessions}\n`);

  // 4. Restart programmatically
  console.log('3. Restarting background server with app.restart({ background: true })...');
  const restartResult = await app.restart({ background: true });
  console.log(`   Restarted! New PID: ${restartResult.pid}, Port: ${restartResult.port}\n`);

  // 5. Cleanly stop background server
  console.log('4. Stopping background server with app.stop({ background: true })...');
  await app.stop({ background: true });
  console.log('   Stopped successfully!\n');

  const finalStatus = await app.status();
  console.log(`Final status: ${finalStatus.status}`);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
