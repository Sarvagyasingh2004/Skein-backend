import amqp from "amqplib";
import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

export const startSendOtpConsumer = async () => {
  try {
    const connection = await amqp.connect({
      protocol: "amqp",
      hostname: process.env.RABBITMQ_HOST,
      port: Number(process.env.RABBITMQ_PORT),
      username: process.env.RABBITMQ_USERNAME,
      password: process.env.RABBITMQ_PASSWORD,
    });

    const channel = await connection.createChannel();
    const queueName = "send-otp";
    await channel.assertQueue(queueName, { durable: true });

    console.log(
      "📨 Mail service consumer started, listening for OTP emails...",
    );

    channel.consume(queueName, async (msg) => {
      if (!msg) return;

      try {
        const { to, subject, body } = JSON.parse(msg.content.toString());

        const transporter = nodemailer.createTransport({
          service: "gmail",
          auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
          },
        });

        await transporter.verify();
        console.log("✅ SMTP verified with Gmail");

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
    });
  } catch (error) {
    console.error("Failed to start RabbitMQ consumer:", error);
  }
};
