import amqp from "amqplib";
import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

const queueName = "send-otp";

// Failures land here instead of being discarded. Declared with no arguments so
// it can never collide with an existing declaration: changing the arguments of
// a live durable queue raises PRECONDITION_FAILED, which closes the channel and
// would put the reconnect loop below into a permanent attach/fail cycle.
//
// Messages are published here explicitly rather than via a dead-letter exchange
// because a DLX would require adding x-dead-letter-exchange to send-otp, which
// already exists with no arguments, and would have to be mirrored in the user
// service's publishToQueue. Publishing directly also lets us record why it
// failed, which x-death headers cannot.
const dlqName = "send-otp.dlq";

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

type OtpPayload = { to: string; subject: string; body: string };

// A Gmail hiccup or rate-limit is usually transient, so a message gets a few
// in-process attempts before it is treated as undeliverable. Bounded by
// prefetch, so a burst of failures cannot pin unlimited messages in memory.
const sendOtp = async (payload: OtpPayload) => {
  const maxAttempts = envInt("MAIL_MAX_ATTEMPTS", 3);
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await ensureVerified();
      await getTransporter().sendMail({
        from: `"Skein" <${process.env.EMAIL_USER}>`,
        to: payload.to,
        subject: payload.subject,
        text: payload.body,
      });
      return attempt;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        const delay = backoffDelay(attempt);
        console.error(
          `Failed to send OTP to ${payload.to} (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms:`,
          error,
        );
        await wait(delay);
      }
    }
  }

  throw lastError;
};

// Returns false when the broker applied back-pressure, so the caller can requeue
// rather than silently drop the message it was trying to preserve.
const deadLetter = (
  channel: amqp.Channel,
  msg: amqp.ConsumeMessage,
  reason: string,
  attempts: number,
) => {
  const envelope = {
    failedAt: new Date().toISOString(),
    reason,
    attempts,
    redelivered: msg.fields.redelivered,
    // Kept as the raw string so an unparseable payload is preserved verbatim
    // for inspection and replay.
    payload: msg.content.toString(),
  };

  return channel.sendToQueue(dlqName, Buffer.from(JSON.stringify(envelope)), {
    persistent: true,
    contentType: "application/json",
  });
};

const handleOtpMessage = async (channel: amqp.Channel, msg: amqp.ConsumeMessage) => {
  let payload: OtpPayload;

  // A malformed payload will never succeed, so it skips the retries entirely.
  try {
    payload = JSON.parse(msg.content.toString());
  } catch (error) {
    console.error("Unparseable OTP message, dead-lettering:", error);
    routeToDlq(channel, msg, `unparseable payload: ${String(error)}`, 0);
    return;
  }

  // Valid JSON of the wrong shape is equally undeliverable. Checked up front so
  // it does not burn every retry and its backoff on a guaranteed failure.
  if (!payload || typeof payload.to !== "string" || !payload.to) {
    console.error("OTP message has no recipient, dead-lettering");
    routeToDlq(channel, msg, "missing or invalid 'to' field", 0);
    return;
  }

  try {
    const attempts = await sendOtp(payload);
    console.log(
      `OTP mail sent to ${payload.to}${attempts > 1 ? ` (attempt ${attempts})` : ""}`,
    );
    channel.ack(msg);
  } catch (error) {
    console.error(
      `Giving up on OTP to ${payload.to} after ${envInt("MAIL_MAX_ATTEMPTS", 3)} attempts, dead-lettering:`,
      error,
    );
    routeToDlq(channel, msg, String(error), envInt("MAIL_MAX_ATTEMPTS", 3));
  }
};

// Ack only once the DLQ has taken the message. If the broker refused it, the
// original is requeued instead, because dropping it here would lose the very
// message the DLQ exists to retain.
const routeToDlq = (
  channel: amqp.Channel,
  msg: amqp.ConsumeMessage,
  reason: string,
  attempts: number,
) => {
  try {
    if (deadLetter(channel, msg, reason, attempts)) {
      channel.ack(msg);
      return;
    }
    console.error("DLQ back-pressured, requeueing instead of dropping");
  } catch (error) {
    console.error("Could not publish to DLQ, requeueing:", error);
  }
  channel.nack(msg, false, true);
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
    await channel.assertQueue(dlqName, { durable: true });

    // A handler can now hold a message for seconds while it retries, so cap how
    // many are in flight. Without this the broker pushes the whole queue at
    // once, which on a 1 GiB box is a real memory risk during an outage.
    await channel.prefetch(envInt("MAIL_PREFETCH", 10));

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
