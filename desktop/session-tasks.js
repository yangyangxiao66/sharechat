import { Worker } from 'node:worker_threads';
const workers = new Set();

export function sessionTask(operation, args = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./session-worker.js', import.meta.url), { workerData: { operation, args } });
    workers.add(worker);
    let settled = false;
    const finish = (error, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(data);
    };
    const timer = setTimeout(() => {
      finish(new Error('会话读取超时，请稍后重试'));
      worker.terminate();
    }, 150000);
    worker.once('message', result => finish(result.ok ? null : new Error(result.error), result.data));
    worker.once('error', error => finish(error));
    worker.once('exit', code => {
      workers.delete(worker);
      if (!settled) finish(new Error(`会话任务提前退出（${code}）`));
    });
  });
}

export function stopSessionTasks() {
  for (const worker of workers) worker.terminate();
}
