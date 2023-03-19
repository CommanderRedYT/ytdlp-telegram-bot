# ytdlp-telegram-bot

This is a telegram bot that uses [yt-dlp](https://github.com/yt-dlp/yt-dlp) to download videos from youtube.

## Usage
```bash
git clone https://github.com/CommanderRedYT/ytdlp-telegram-bot
cd ytdlp-telegram-bot
yarn install

# Configure
cp .env.default .env

# Edit .env to your needs

# Run
yarn start
```

## Configuration
```bash
# .env
TELEGRAM_BOT_TOKEN=<your telegram bot token>
JWT_SECRET=<your jwt secret>
DATA_DIRECTORY=<your data directory>
CHMOD=<chmod for data directory>
```

## Bot commands
```
/start - Start the bot. This will generate and print a token.
/token <token> - Authenticate with the bot. After that, you can just send a youtube link to download it.
