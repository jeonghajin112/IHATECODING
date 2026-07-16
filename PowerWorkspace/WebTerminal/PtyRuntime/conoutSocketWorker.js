"use strict";

const { parentPort } = require("worker_threads");
const net = require("net");
const { getWorkerPipeName } = require("../shared/conout");

const pipes = new Map();

function addPipe(message) {
  const conoutSocket = new net.Socket();
  conoutSocket.setEncoding("utf8");
  conoutSocket.on("error", () => { });
  conoutSocket.connect(message.conoutPipeName, () => {
    const server = net.createServer(workerSocket => {
      workerSocket.on("error", () => { });
      conoutSocket.pipe(workerSocket);
    });
    server.on("error", () => { });
    server.listen(getWorkerPipeName(message.conoutPipeName), () => {
      pipes.set(message.id, { conoutSocket, server });
      parentPort.postMessage({ type: "ready", id: message.id });
    });
  });
}

function removePipe(id) {
  const pipe = pipes.get(id);
  if (!pipe) return;
  pipes.delete(id);
  try { pipe.server.close(); } catch (_) { }
  try { pipe.conoutSocket.destroy(); } catch (_) { }
}

parentPort.on("message", message => {
  if (message.type === "add") addPipe(message);
  else if (message.type === "remove") removePipe(message.id);
});
