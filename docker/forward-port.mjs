import net from "node:net";

// Forward HTTP and WebSocket bytes to the isolated test service only.
net.createServer(client => {
  const upstream = net.connect({ host: "affine", port: 3010 });
  const close = () => { client.destroy(); upstream.destroy(); };
  client.on("error", close);
  upstream.on("error", close);
  client.on("close", close);
  upstream.on("close", close);
  client.pipe(upstream).pipe(client);
}).listen(3010, "0.0.0.0");
