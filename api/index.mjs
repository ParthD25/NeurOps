import { createServer } from "../server.mjs";

const server = createServer();

export default function handler(req, res) {
  server.emit("request", req, res);
}
