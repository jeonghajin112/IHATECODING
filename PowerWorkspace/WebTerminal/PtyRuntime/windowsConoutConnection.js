"use strict";

// node-pty normally creates one V8 worker thread per PTY to drain ConPTY
// output. IHATECODING can host twenty terminals, so one shared worker drains all
// named pipes and avoids twenty separate JavaScript heaps.
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConoutConnection = void 0;

const { Worker } = require("worker_threads");
const path = require("path");
const { getWorkerPipeName } = require("./shared/conout");
const { EventEmitter2 } = require("./eventEmitter2");

const FLUSH_DATA_INTERVAL = 1000;
let sharedWorker;
let nextConnectionId = 1;
const connections = new Map();

function getSharedWorker() {
  if (sharedWorker) return sharedWorker;
  const scriptPath = __dirname.replace("node_modules.asar", "node_modules.asar.unpacked");
  sharedWorker = new Worker(path.join(scriptPath, "worker/conoutSocketWorker.js"));
  sharedWorker.on("message", message => {
    const connection = connections.get(message.id);
    if (!connection) return;
    if (message.type === "ready") connection._onReady.fire();
  });
  sharedWorker.on("exit", () => {
    sharedWorker = undefined;
    connections.clear();
  });
  return sharedWorker;
}

class ConoutConnection {
  constructor(conoutPipeName, useConptyDll) {
    this._conoutPipeName = conoutPipeName;
    this._useConptyDll = useConptyDll;
    this._isDisposed = false;
    this._onReady = new EventEmitter2();
    this._id = nextConnectionId++;
    connections.set(this._id, this);
    getSharedWorker().postMessage({
      type: "add",
      id: this._id,
      conoutPipeName
    });
  }

  get onReady() {
    return this._onReady.event;
  }

  connectSocket(socket) {
    socket.connect(getWorkerPipeName(this._conoutPipeName));
  }

  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;
    setTimeout(() => {
      connections.delete(this._id);
      if (sharedWorker) sharedWorker.postMessage({ type: "remove", id: this._id });
    }, FLUSH_DATA_INTERVAL);
  }
}

exports.ConoutConnection = ConoutConnection;
