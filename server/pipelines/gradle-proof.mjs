// Copied into the run notes so verification runs in the worker's own shell.
// Gradle determines freshness using each task's declared inputs and outputs.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile, rename } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const taskName = /^:?(?:[\w.-]+:)*[a-zA-Z][\w.-]*$/;
function requireField(field, condition) {
  if (!condition) throw new Error('Invalid Gradle verification receipt field ' + field);
}

export function validateGradleReceipt(row) {
  requireField('receipt', row && typeof row === 'object');
  requireField('id', /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.id));
  requireField('stepIndex', Number.isInteger(row.stepIndex) && row.stepIndex >= 0 && row.stepIndex <= 32);
  requireField('attempt', Number.isSafeInteger(row.attempt) && row.attempt > 0);
  requireField('cwd', typeof row.cwd === 'string' && path.isAbsolute(row.cwd) && !/[\x00-\x1f]/.test(row.cwd));
  requireField('tasks', Array.isArray(row.tasks) && row.tasks.length > 0 && row.tasks.length <= 32
    && row.tasks.every(task => typeof task === 'string' && task.length <= 100 && taskName.test(task)));
  for (const field of ['startedAt','endedAt']) {
    requireField(field, typeof row[field] === 'string' && Number.isFinite(Date.parse(row[field])));
  }
  requireField('endedAt', Date.parse(row.endedAt) >= Date.parse(row.startedAt));
  requireField('exitCode', Number.isInteger(row.exitCode) && row.exitCode >= 0 && row.exitCode <= 255);
  for (const key of ['reused','executed','skipped']) requireField(key, Number.isSafeInteger(row[key]) && row[key] >= 0);
  requireField('outputDigest', typeof row.outputDigest === 'string' && /^[a-f0-9]{64}$/.test(row.outputDigest));
  return row;
}

async function verify([step, attempt, ...tasks]) {
  const startedAt = new Date().toISOString();
  const receipt = validateGradleReceipt({id:randomUUID(), stepIndex:Number(step), attempt:Number(attempt), tasks,
    cwd:process.cwd(), startedAt, endedAt:startedAt, exitCode:0, reused:0, executed:0, skipped:0, outputDigest:'0'.repeat(64)});
  const output = createHash('sha256');
  const child = spawn('./gradlew', ['--console=plain', ...tasks], {stdio:['ignore','pipe','pipe']});
  for (const [stream, destination] of [[child.stdout,process.stdout],[child.stderr,process.stderr]]) {
    stream.on('data', bytes => { output.update(bytes); destination.write(bytes); });
  }
  const lines = createInterface({input:child.stdout});
  lines.on('line', line => {
    const task = /^> Task (:\S+)(?: (UP-TO-DATE|FROM-CACHE|SKIPPED|NO-SOURCE|FAILED))?$/.exec(line);
    if (!task) return;
    if (['UP-TO-DATE','FROM-CACHE'].includes(task[2])) receipt.reused++;
    else if (['SKIPPED','NO-SOURCE'].includes(task[2])) receipt.skipped++;
    else receipt.executed++;
  });
  receipt.exitCode = await new Promise((resolve,reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code ?? 1));
  });
  receipt.endedAt = new Date().toISOString();
  receipt.outputDigest = output.digest('hex');
  validateGradleReceipt(receipt);
  const name = path.join(path.dirname(fileURLToPath(import.meta.url)), `gradle-${receipt.stepIndex}-${receipt.attempt}-${receipt.id}.json`);
  await writeFile(name + '.tmp', JSON.stringify(receipt), {flag:'wx',mode:0o600});
  await rename(name + '.tmp',name);
  console.log(`GRADLE_RECEIPT ${receipt.attempt} ${receipt.id}`);
  process.exitCode = receipt.exitCode;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await verify(process.argv.slice(2));
}
