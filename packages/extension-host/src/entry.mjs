import { controllerMain } from './controller.mjs';
import { workerMain } from './worker.mjs';
const run =
  process.argv[2] === '--worker'
    ? workerMain(process.argv[3], JSON.parse(process.argv[4]))
    : controllerMain();
run.catch((error) => {
  process.stderr.write(String(error.message) + '\n');
  process.exit(1);
});
