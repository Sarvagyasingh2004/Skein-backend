import amqp from "amqplib";
import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

const queueName = "send-otp";

let connection: amqp.ChannelModel | null = null;

// Cleared as soon as the connection emits "close", so teardown can tell a
// connection that still needs closing from one the broker already dropped.
let connectionOpen = false;

// True while a connect/retry loop is in flight. Set synchronously so the close
// handlers below can never kick off a second, competing loop.
let connecting = false;

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

// Built once and reused. The previous code created a transport and ran a full
// verify() handshake per message, which added an SMTP connect + auth round trip
// to every OTP. Created lazily so EMAIL_* are read after dotenv has loaded.
let transporter: nodemailer.Transporter | null = null;
let verified: Promise<unknown> | null = null;

const getTransporter = () => {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });
  }
  return transporter;
};

// Verified once per process, not once per message. The cached promise means a
// burst of OTPs at startup shares a single handshake rather than racing.
const ensureVerified = () => {
  const mailer = getTransporter();
  if (!verified) {
    verified = mailer.verify().then((result) => {
      console.log("✅ SMTP verified with Gmail");
      return result;
    }).catch((error) => {
      // Allow a later message to retry instead of caching the failure forever.
      verified = null;
      throw error;
    });
  }
  return verified;
};

const handleOtpMessage = async (channel: amqp.Channel, msg: amqp.ConsumeMessage) => {
  try {
    const { to, subject, body } = JSON.parse(msg.content.toString());

    await ensureVerified();
    const transporter = getTransporter();

    await transporter.sendMail({
      from: `"Skein" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      text: body,
    });

    console.log(`OTP mail sent to ${to}`);
    channel.ack(msg);
  } catch (error) {
    console.error("Failed to send OTP:", error);
    channel.nack(msg, false, false); // discard message to avoid infinite loop
  }
};

const attachConsumer = async () => {
  const conn = await amqp.connect({
    protocol: "amqp",
    hostname: process.env.RABBITMQ_HOST,
    port: Number(process.env.RABBITMQ_PORT),
    username: process.env.RABBITMQ_USERNAME,
    password: process.env.RABBITMQ_PASSWORD,
  });

  let channel: amqp.Channel;
  try {
    channel = await conn.createChannel();
    await channel.assertQueue(queueName, { durable: true });
    await channel.consume(queueName, (msg) => {
      if (!msg) return;
      void handleOtpMessage(channel, msg);
    });
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

  channel.on("error", (error) => {
    console.error("Rabbitmq channel error:", error);
  });
  channel.once("close", () => handleConnectionLoss("channel closed"));

  connection = conn;
  connectionOpen = true;
};

const connectWithRetry = async () => {
  const maxAttempts = envInt("RABBITMQ_MAX_RETRIES", 12);

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await attachConsumer();
        // Logged only once the consumer is genuinely attached to the queue.
        console.log(
          "📨 Mail service consumer started, listening for OTP emails...",
        );
        return;
      } catch (error) {
        if (attempt === maxAttempts) {
          console.error(
            `Failed to start RabbitMQ consumer after ${maxAttempts} attempts, exiting so the process manager can restart the service:`,
            error,
          );
          process.exit(1);
        }

        const delay = backoffDelay(attempt);
        console.error(
          `Failed to start RabbitMQ consumer (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms:`,
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
  connection = null;
  connectionOpen = false;

  console.error(
    `Lost connection to rabbitmq (${reason}), reattaching consumer...`,
  );

  void (async () => {
    await closeQuietly(lost);
    await connectWithRetry();
  })();
};

export const startSendOtpConsumer = async () => {
  if (connecting) return;
  connecting = true;
  await connectWithRetry();
};
