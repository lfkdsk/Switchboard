import holderModule from "../../cli/lib/pty-holder.js";

const { connectPtyHolder } = holderModule;
const mode = process.env.HOLDER_TEST_MODE;
const socketPath = process.env.HOLDER_TEST_SOCKET;
const client = await connectPtyHolder(socketPath);
let output = "";
let replay = null;
let reported = false;

const timer = setTimeout(() => {
  process.send?.({ type: "error", message: `timed out in ${mode} mode; output=${JSON.stringify(output)}` });
  client.disconnect();
  process.exit(1);
}, 10000);

client.on("data", (chunk) => {
  output += chunk.toString("utf8");
  if (reported) return;
  if (mode === "first" && output.includes("HOLDER_BEFORE\r\n")) {
    reported = true;
    process.send?.({
      type: "before",
      offset: client.offset,
      shellPid: client.pid,
      holderPid: client.holderPid,
    });
  }
  if (mode === "second" && output.includes("HOLDER_DURING\r\n")) {
    reported = true;
    process.send?.({
      type: "recovered",
      output,
      replay,
      shellPid: client.pid,
      holderPid: client.holderPid,
    });
    client.write("exit\n");
  }
  if (mode === "split-utf8" && output.includes("UTF8_SPLIT=雪\r\n")) {
    reported = true;
    process.send?.({ type: "utf8", output });
    client.write("exit\n");
  }
});
client.on("session-replay", (message) => { replay = message; });
client.on("exit", (message) => {
  if (mode === "second" || mode === "split-utf8") {
    clearTimeout(timer);
    process.send?.({ type: "exit", code: message.code });
    setTimeout(() => process.exit(0), 10);
  }
});
client.on("disconnect", () => {
  if (!reported && mode === "second") {
    clearTimeout(timer);
    process.send?.({ type: "error", message: "holder disconnected before replay completed" });
    process.exit(1);
  }
});
client.activate();

if (mode === "first") {
  client.write("printf 'HOLDER_BEFORE\\n'; (sleep 0.5; printf 'HOLDER_DURING\\n') &\n");
} else if (mode === "second") {
  client.replay(Number(process.env.HOLDER_TEST_SINCE), false);
} else if (mode === "split-utf8") {
  const command = Buffer.from("printf 'UTF8_SPLIT=雪\\n'\n");
  const snow = Buffer.from("雪");
  const split = command.indexOf(snow) + 1;
  client.write(command.subarray(0, split));
  client.write(command.subarray(split));
} else {
  throw new Error(`unknown holder test mode: ${mode}`);
}

process.on("SIGTERM", () => {
  clearTimeout(timer);
  client.disconnect();
  process.exit(0);
});
