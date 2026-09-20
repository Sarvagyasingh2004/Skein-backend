// Inspect, replay or purge the OTP dead-letter queue.
//
//   node scripts/dlq.mjs peek [limit]     non-destructive: prints and requeues
//   node scripts/dlq.mjs replay [limit]   republish to send-otp, remove from DLQ
//   node scripts/dlq.mjs purge --yes      discard everything in the DLQ
//
// Run from the mail service directory so dotenv finds .env and node resolves
// node_modules:  cd ~/apps/backend/mail && node scripts/dlq.mjs peek
import "dotenv/config";
import amqp from "amqplib";

const QUEUE = "send-otp";
const DLQ = "send-otp.dlq";

const [command = "peek", ...rest] = process.argv.slice(2);
const limit = Number(rest.find((a) => /^\d+$/.test(a))) || Infinity;
const confirmed = rest.includes("--yes");

if (!["peek", "replay", "purge"].includes(command)) {
  console.error(`Unknown command "${command}". Use peek, replay or purge.`);
  process.exit(2);
}

if (command === "purge" && !confirmed) {
  console.error("purge discards messages permanently. Re-run with --yes.");
  process.exit(2);
}

const connection = await amqp.connect({
  protocol: "amqp",
  hostname: process.env.RABBITMQ_HOST,
  port: Number(process.env.RABBITMQ_PORT),
  username: process.env.RABBITMQ_USERNAME,
  password: process.env.RABBITMQ_PASSWORD,
});
const channel = await connection.createChannel();

// Snapshot the depth up front and never process more than that.
//
// Without this bound, replay races the live consumer: a replayed message that
// fails again lands straight back in the DLQ, where the still-running loop
// picks it up and replays it once more. In testing a single bad message was
// replayed 107 times before the loop happened to find the queue empty.
// Messages that arrive mid-run are deliberately left for the next invocation.
const { messageCount } = await channel.assertQueue(DLQ, { durable: true });
const budget = Math.min(limit, messageCount);

if (messageCount === 0) {
  console.log(`${DLQ} is empty`);
  await channel.close();
  await connection.close();
  process.exit(0);
}

console.log(`${DLQ} holds ${messageCount} message(s); processing ${budget}\n`);

// peek must not consume, so messages are held and requeued together at the end.
// Requeueing each one as it is read would hand it straight back and loop.
const held = [];
let count = 0;

try {
  while (count < budget) {
    const msg = await channel.get(DLQ, { noAck: false });
    if (!msg) break;
    count++;

    let envelope;
    try {
      envelope = JSON.parse(msg.content.toString());
    } catch {
      envelope = { unreadable: msg.content.toString() };
    }

    if (command === "peek") {
      console.log(`--- ${count} ---`);
      console.log(JSON.stringify(envelope, null, 2));
      held.push(msg);
      continue;
    }

    if (command === "replay") {
      if (typeof envelope.payload !== "string") {
        console.error(`#${count}: no original payload, leaving in place`);
        held.push(msg);
        continue;
      }
      channel.sendToQueue(QUEUE, Buffer.from(envelope.payload), {
        persistent: true,
      });
      channel.ack(msg);
      console.log(`#${count}: replayed to ${QUEUE} (failed ${envelope.failedAt})`);
      continue;
    }

    channel.ack(msg); // purge
  }
} finally {
  // Put anything only inspected back where it was.
  for (const msg of held) channel.nack(msg, false, true);
  await channel.close();
  await connection.close();
}

const verb = { peek: "inspected", replay: "replayed", purge: "purged" }[command];
console.log(`\n${verb} ${count} message(s)`);
if (command === "replay" && count > 0) {
  console.log("Fix the underlying cause first, or they will land back here.");
}
