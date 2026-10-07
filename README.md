# a22 Chat

Чат с WebRTC-звонками на Node.js + Socket.IO + SQLite. Запуск через Docker.

## Стек
- Node.js 20, Express, Socket.IO
- SQLite (better-sqlite3), JWT
- WebRTC (STUN/TURN)
- Docker Compose

## Запуск
1. cp .env.example .env
2. Отредактируйте .env (JWT_SECRET, ADMIN_PASSWORD, TURN_*)
3. docker compose up -d --build
4. Откройте http://127.0.0.1:3080 или ваш домен

Админ создаётся автоматически при первом старте.
Новые пользователи добавляются админом в сайдбаре.

## Reverse-proxy
Приложение слушает 127.0.0.1:3080. Для Nginx обязательны заголовки
Upgrade и Connection "upgrade" — иначе Socket.IO не поднимется.
