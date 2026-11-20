// Run a browser module worker unchanged in a Node worker thread for search tests.
import { Worker } from 'node:worker_threads';

export class BrowserWorker {
  constructor(url) {
    this.worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      globalThis.self = globalThis;
      globalThis.postMessage = (data) => parentPort.postMessage(data);
      import(workerData).then(() => parentPort.on('message', (data) => self.onmessage({ data })));
    `, { eval: true, workerData: String(url) });
    this.worker.on('message', (data) => this.onmessage?.({ data }));
    this.worker.on('error', (error) => this.onerror?.(error));
  }
  postMessage(data) { this.worker.postMessage(data); }
  terminate() { return this.worker.terminate(); }
}
