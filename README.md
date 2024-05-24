Telegram bot checker, similar to https://github.com/mbakhtin/website-checker-bot but made using Yandex Cloud.

## Setup

- create ydb, apply create_tables.yql
- create lockbox secret, change environment (2 places) in serverless.yaml

```
npm i
npm run deploy
```

- for local development create .env file similar to .env.example

```npm run test```