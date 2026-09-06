# Skein Backend

Backend for Skein, a real-time chat application. Three independently deployable
Node.js services provide passwordless email authentication, a Socket.IO
messaging gateway, and a queue-driven mail worker.

Frontend: [Microservices_chat_frontend](https://github.com/Sarvagyasingh2004/Microservices_chat_frontend)

## Architecture

```
                        ┌──────────────────┐
                        │  Next.js client  │
                        └────────┬─────────┘
                     REST        │        REST + WebSocket
               ┌─────────────────┴──────────────────┐
               │                                    │
       ┌───────▼────────┐   GET /user/:id   ┌───────▼─────────┐
       │  user service  │◄──────────────────┤  chat service   │
       │     :3000      │                   │     :3002       │
       │                │                   │                 │
       │ • OTP login    │                   │ • chats         │
       │ • JWT issuing  │                   │ • messages      │
       │ • profiles     │                   │ • seen receipts │
       │ • directory    │                   │ • Socket.IO     │
       └───┬────────┬───┘                   └──┬──────┬───┬───┘
           │        │                          │      │   │
     ┌─────▼──┐  ┌──▼──────────┐        ┌──────▼──┐ ┌─▼───▼──────┐
     │ Redis  │  │  RabbitMQ   │        │ MongoDB │ │Redis (sock)│
     │ OTP +  │  │  "send-otp" │        └─────────┘ │ Cloudinary │
     │ rate   │  └──────┬──────┘                    └────────────┘
     │ limit  │         │ consumes
     └────────┘  ┌──────▼───────┐
                 │ mail service │
                 │    :3001     │──► Gmail SMTP
                 └──────────────┘
```

| Service | Port | Responsibility | Depends on |
|---|---|---|---|
| `user` | 3000 | OTP login, JWT issuing, profile, user directory | MongoDB, Redis, RabbitMQ |
| `chat` | 3002 | Chats, messages, seen receipts, image upload, sockets | MongoDB, Redis, Cloudinary, user service |
| `mail` | 3001 | Consumes `send-otp`, delivers mail over SMTP | RabbitMQ |

The user and chat services share one MongoDB deployment and verify the same
`JWT_SECRET`, so a token issued by `user` is accepted by `chat` without an auth
round trip. The chat service calls `GET /api/v1/user/:id` to hydrate the other
participant's name and email onto a conversation.

## Authentication

`POST /login` does not talk to SMTP. It writes the OTP to Redis, publishes to the
durable `send-otp` queue and returns, so sign-in latency does not depend on mail
delivery. The mail service consumes the queue independently. Failed sends are
rejected without requeue so a bad address cannot loop.

1. `POST /api/v1/login` checks `otp:ratelimit:<email>` in Redis. Present, `429`.
2. Generates a 6-digit OTP, stores it at `otp:<email>` with a 300s TTL, and sets
   the rate-limit key with a 60s TTL.
3. Publishes `{ to, subject, body }` to `send-otp`, responds `200`.
4. The mail service consumes it and sends via Nodemailer.
5. `POST /api/v1/verify` compares against Redis. On first successful verify the
   user is created, with the display name defaulting to the first 8 characters of
   the email address. A JWT is returned.

Token lifetime is set by `JWT_EXPIRES_IN` and defaults to `7d`.

## Read receipts

When a message is sent, the chat service asks the Socket.IO adapter which
sockets are joined to that chat's room. If one of them belongs to the recipient,
the message is written with `seen: true` and a `messagesSeen` event is emitted
back to the sender. Otherwise it stays unseen until the recipient opens the
thread, at which point `GET /message/:chatId` bulk-marks the incoming messages
and emits the receipt.

Because the room lookup goes through the Redis adapter rather than a local map,
this works with multiple chat-service instances behind a load balancer. Online
presence is derived the same way, from the adapter's socket registry, so it does
not go stale when an instance restarts.

## Data model

```
User    { name, email (unique), timestamps }
Chat    { users: [userId, userId], latestMessage: { text, sender }, timestamps }
Message { chatId -> Chat, sender, text?, image? { url, publicId },
          messageType: "text" | "image", seen, seenAt?, timestamps }
```

`Chat.latestMessage` is a denormalised snapshot so the conversation list renders
without reading the messages collection.

## Tech

Node.js, TypeScript (ESM), Express 5, MongoDB/Mongoose, Redis, RabbitMQ
(amqplib), Socket.IO with the Redis adapter, JWT, Nodemailer, Cloudinary, Multer.

## Getting started

### Prerequisites

- Node.js 20 or newer
- MongoDB, Redis and RabbitMQ reachable from your machine

Use managed instances, or run the stateful pieces locally:

```bash
docker run -d --name skein-redis    -p 6379:6379 redis:7-alpine
docker run -d --name skein-rabbitmq -p 5672:5672 -p 15672:15672 rabbitmq:3-management-alpine
```

RabbitMQ's management UI is at http://localhost:15672 with `guest`/`guest`. To
use different credentials, create the user first:

```bash
docker exec skein-rabbitmq rabbitmqctl add_user <user> <password>
docker exec skein-rabbitmq rabbitmqctl set_user_tags <user> administrator
docker exec skein-rabbitmq rabbitmqctl set_permissions -p / <user> ".*" ".*" ".*"
```

### Environment

Each service reads its own `.env`. All three are gitignored.

<details>
<summary><code>user/.env</code></summary>

```env
PORT=3000
MONGO_URI=
REDIS_URL=redis://localhost:6379
RABBITMQ_HOST=localhost
RABBITMQ_PORT=5672
RABBITMQ_USERNAME=
RABBITMQ_PASSWORD=
JWT_SECRET=
JWT_EXPIRES_IN=7d
CORS_ORIGIN=http://localhost:3000
```
</details>

<details>
<summary><code>chat/.env</code></summary>

```env
PORT=3002
MONGO_URI=
REDIS_URL=redis://localhost:6379
JWT_SECRET=
USER_SERVICE=http://localhost:3000
CORS_ORIGIN=http://localhost:3000
CLOUD_NAME=
API_KEY=
API_SECRET=
```
</details>

<details>
<summary><code>mail/.env</code></summary>

```env
PORT=3001
RABBITMQ_HOST=localhost
RABBITMQ_PORT=5672
RABBITMQ_USERNAME=
RABBITMQ_PASSWORD=
EMAIL_USER=
EMAIL_PASS=
```
</details>

`JWT_SECRET` must match between `user` and `chat`. `CORS_ORIGIN` accepts a
comma-separated list and defaults to localhost origins when unset. `EMAIL_PASS`
is a Gmail app password, not the account password. Both services set
`dbName: "microservices-chat-app"`, which overrides any database named in the
`MONGO_URI` path.

### Run

```bash
cd user && npm install && npm run build && npm start   # :3000
cd mail && npm install && npm run build && npm start   # :3001
cd chat && npm install && npm run build && npm start   # :3002
```

Start `user` before `chat`, since the chat service calls it to resolve
participants. For development with rebuild on change, use `npm run dev`.

## API

All routes are prefixed `/api/v1`. Authenticated routes require
`Authorization: Bearer <token>`.

### user service, `:3000`

| Method | Route | Auth | Body / Params | Notes |
|---|---|:--:|---|---|
| `POST` | `/login` | no | `{ email }` | `429` if requested within 60s |
| `POST` | `/verify` | no | `{ email, otp }` | Creates the user on first verify |
| `GET` | `/me` | yes | | Returns the decoded token user |
| `GET` | `/users/all` | yes | | Full user directory |
| `GET` | `/user/:id` | no | | Used by the chat service |
| `POST` | `/user/update` | yes | `{ name }` | Returns a new token |

### chat service, `:3002`

| Method | Route | Auth | Body / Params | Notes |
|---|---|:--:|---|---|
| `POST` | `/chat/new` | yes | `{ otherUserId }` | Returns the existing chat if one exists |
| `GET` | `/chat/all` | yes | | Conversations with `unseenCount`, newest first |
| `POST` | `/message` | yes | `{ chatId, text }` or multipart `image` | Images go to Cloudinary |
| `GET` | `/message/:chatId` | yes | | Bulk-marks incoming messages as seen |

Uploads accept jpg, jpeg, png, gif and webp up to 5MB, and are resized to fit
within 800x600 by Cloudinary before storage.

### Socket.IO, `:3002`

Connect with the user id in the handshake:
`io(CHAT_URL, { query: { userId } })`.

| Direction | Event | Payload |
|---|---|---|
| server to all | `getOnlineUser` | `string[]` of online user ids |
| client to server | `joinChat` / `leaveChat` | `chatId` |
| client to server | `typing` / `stopTyping` | `{ chatId, userId }` |
| server to room | `userTyping` / `userStoppedTyping` | `{ chatId, userId }` |
| server to room and participants | `newMessage` | the saved message |
| server to sender | `messagesSeen` | `{ chatId, seenBy, messageIds }` |

Every socket joins a room named after its user id, so the services address a user
directly rather than tracking socket ids.

## Deployment

Clone the repo onto a Linux host, create the three `.env` files, then build and
start each service:

```bash
git clone https://github.com/Sarvagyasingh2004/Microservices_chat_backend.git
cd Microservices_chat_backend
npm install && npm run build && npm start
```

Use a process manager such as `pm2` or systemd units so the services restart on
crash and survive reboots, and open ports 3000 to 3002 in the host firewall. Set
`CORS_ORIGIN` on the user and chat services to the deployed frontend origin.

MongoDB, Redis and RabbitMQ are external, either managed services or installed on
the same host. Redis is required by both the user service, for OTP storage, and
the chat service, for the Socket.IO adapter.
