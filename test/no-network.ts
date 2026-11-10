import { Server, Socket } from "node:net";

function unexpectedNetwork(): never {
  throw new Error("The offline CLI attempted network I/O.");
}

globalThis.fetch = unexpectedNetwork;
Socket.prototype.connect = unexpectedNetwork;
Server.prototype.listen = unexpectedNetwork;
