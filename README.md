
---

# 📕 Backend README (`backend/README.md`)

```md
# Backend – Microservices for Real-Time Chat 🚀

This repository contains the **backend microservices** for a real-time chat application, deployed on **AWS EC2**.

The backend follows an **event-driven microservices architecture** using **RabbitMQ** and **WebSockets**.

---

## 🧠 Services Overview

| Service | Responsibility | Port |
|------|---------------|------|
| User Service | Authentication & user management | 3000 |
| Mail Service | Email notifications | 3001 |
| Chat Service | Real-time messaging & WebSockets | 3002 |

---

## 🌐 AWS Deployment Details

### 🔹 EC2 Public IP : 51.21.219.172


### 🔹 Live Service URLs

| Service | URL |
|------|-----|
| User Service | http://51.21.219.172:3000 |
| Mail Service | http://51.21.219.172:3001 |
| Chat Service | http://51.21.219.172:3002 |
| RabbitMQ Dashboard | http://51.21.219.172:15672 |

**RabbitMQ Credentials**
- Username: `guest`
- Password: `guest`

---

## 📦 Project Structure

backend/
├── user/
│   ├── .env.example
│   └── src/
├── chat/
│   ├── .env.example
│   └── src/
└── mail/
    ├── .env.example
    └── src/

🔐 Environment Setup

Each service has its own .env file:

cp user/.env.example user/.env
cp chat/.env.example chat/.env
cp mail/.env.example mail/.env

Example:

PORT=3000
MONGODB_URI=mongodb://localhost:27017/chat-app
RABBITMQ_URL=amqp://localhost:5672
JWT_SECRET=your_secret_key

▶️ Running Services (EC2 or Local)
# User Service
cd user && npm install && npm run start


# Mail Service
cd ../mail && npm install && npm run start


# Chat Service
cd ../chat && npm install && npm run start

📨 Event Flow

User authenticates via User Service

Client opens WebSocket connection to Chat Service

Chat messages are published as events to RabbitMQ

Mail Service consumes events for notifications

Messages are broadcast in real time to connected users


🔐 AWS Security Group Requirements

Ensure the EC2 instance allows inbound traffic on:

3000  (User Service)
3001  (Mail Service)
3002  (Chat Service)
3003  (Frontend)
5672  (RabbitMQ)
15672 (RabbitMQ UI)


🧠 Architecture Benefits

Loose coupling via RabbitMQ

Asynchronous event handling

Real-time communication using Socket.IO

Independently scalable services

Production-ready deployment on AWS EC2
