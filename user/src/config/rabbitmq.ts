import amqp from "amqplib";

let channel: amqp.Channel | null = null;
let connection: amqp.ChannelModel | null = null;

// Cleared as soon as the connection emits "close", so teardown can tell a
// connection that still needs closing from one the broker already dropped.
let connectionOpen = false;

// True while a connect/retry loop is in flight. Set synchronously so the close
// handlers below can never kick off a second, competing loop.
let connecting = false;

// Read lazily: this module is imported before dotenv.config() runs in index.js,
// so anything read at module scope would miss the values from .env.
const envInt = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Exponential backoff capped at RABBITMQ_RETRY_MAX_MS, with +/-20% jitter so
// the services do not all retry on the same tick after a broker restart.
const backoffDelay = (attempt: number) => {
  const base = envInt("RABBITMQ_RETRY_BASE_MS", 1000);
  const max = envInt("RABBITMQ_RETRY_MAX_MS", 30000);
  const delay = Math.min(base * 2 ** (attempt - 1), max);
  return Math.round(delay * (0.8 + Math.random() * 0.4));
};

// close() on a connection the broker is already tearing down can stay pending
// forever, so the wait is bounded: the "close" event is the real signal that
// the old connection is gone, and the timeout is a last-resort backstop.
const CLOSE_TIMEOUT_MS = 5000;

const closeQuietly = async (conn: amqp.ChannelModel | null) => {
  if (!conn) return;
  try {
    const closed = new Promise<void>((resolve) => {
      conn.once("close", () => resolve());
    });
    const requested = conn.close().catch(() => {
      // Already gone; nothing left to clean up.
    });
    await Promise.race([requested, closed, wait(CLOSE_TIMEOUT_MS)]);
  } catch {
    // Never let cleanup block the reconnect.
  }
};

const openConnection = async () => {
  const conn = await amqp.connect({
    protocol: "amqp",
    hostname: process.env.RABBITMQ_HOST,
    port: Number(process.env.RABBITMQ_PORT),
    username: process.env.RABBITMQ_USERNAME,
    password: process.env.RABBITMQ_PASSWORD,
  });

  let ch: amqp.Channel;
  try {
    ch = await conn.createChannel();
  } catch (error) {
    await closeQuietly(conn);
    throw error;
  }

  // amqplib emits "error" before "close" on an abnormal drop, and an unhandled
  // "error" event would take the process down, so both ends are bound. Only
  // "close" triggers a reconnect, otherwise a single drop would start two.
  conn.on("error", (error) => {
    console.error("Rabbitmq connection error:", error);
  });
  conn.once("close", () => {
    connectionOpen = false;
    handleConnectionLoss("connection closed");
  });

  ch.on("error", (error) => {
    console.error("Rabbitmq channel error:", error);
  });
  ch.once("close", () => handleConnectionLoss("channel closed"));

  connection = conn;
  channel = ch;
  connectionOpen = true;
};

const connectWithRetry = async () => {
  const maxAttempts = envInt("RABBITMQ_MAX_RETRIES", 12);

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await openConnection();
        console.log("Connected to rabbitmq");
        return;
      } catch (error) {
        if (attempt === maxAttempts) {
          console.error(
            `Failed to connect to rabbitmq after ${maxAttempts} attempts, exiting so the process manager can restart the service:`,
            error,
          );
          process.exit(1);
        }

        const delay = backoffDelay(attempt);
        console.error(
          `Failed to connect to rabbitmq (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms:`,
          error,
        );
        await wait(delay);
      }
    }
  } finally {
    connecting = false;
  }
};

const handleConnectionLoss = (reason: string) => {
  if (connecting) return;
  connecting = true;

  // Only a connection that has not already closed itself needs tearing down.
  const lost = connectionOpen ? connection : null;
  channel = null;
  connection = null;
  connectionOpen = false;

  console.error(`Lost connection to rabbitmq (${reason}), reconnecting...`);

  void (async () => {
    await closeQuietly(lost);
    await connectWithRetry();
  })();
};

export const connectRabbitMQ = async () => {
  if (connecting) return;
  connecting = true;
  await connectWithRetry();
};

export const publishToQueue = async (queueName: string, message: any) => {
  const activeChannel = channel;
  if (!activeChannel) {
    throw new Error("Rabbitmq channel is not initialized");
  }
  await activeChannel.assertQueue(queueName, { durable: true }); //retry even when error occurs

  activeChannel.sendToQueue(queueName, Buffer.from(JSON.stringify(message)), {
    persistent: true,
  }); //used in mail service
};
