// Standalone convenience command; the personal collector uses the same producer.
import { runPersonalTask } from './seed-personal-task.mjs';
runPersonalTask('pizzint').then(code => { if (code === 0) console.log("=== Done ==="); process.exitCode = code; })
  .catch(error => { console.error(error.message); process.exitCode = 1; });
