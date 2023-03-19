import * as dotenv from 'dotenv';
import * as TelegramBot from 'node-telegram-bot-api';
import ConfigManager from './config';
import * as jwt from 'jsonwebtoken';
import { exec } from 'child_process';

dotenv.config();

// regex list for yt-dlp
const ytDlpRegexList = [
    // youtube
    /https?:\/\/(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,
    /https?:\/\/(?:www\.)?youtube\.com\/playlist\?list=([a-zA-Z0-9_-]{34})/,
    /https?:\/\/(?:www\.)?youtube\.com\/channel\/([a-zA-Z0-9_-]{24})/,
    /https?:\/\/(?:www\.)?youtube\.com\/user\/([a-zA-Z0-9_-]{24})/,
    /https?:\/\/(?:www\.)?youtube\.com\/c\/([a-zA-Z0-9_-]{24})/,
    /https?:\/\/youtu\.be\/([a-zA-Z0-9_-]{11})/,
    // youtube music
    /https?:\/\/music\.youtube\.com\/playlist\?list=([a-zA-Z0-9_-]{34})/,
    /https?:\/\/music\.youtube\.com\/channel\/([a-zA-Z0-9_-]{24})/,
    /https?:\/\/music\.youtube\.com\/user\/([a-zA-Z0-9_-]{24})/,
    /https?:\/\/music\.youtube\.com\/c\/([a-zA-Z0-9_-]{24})/,
    // youtube short
    /https?:\/\/youtu\.be\/([a-zA-Z0-9_-]{11})/,
];

const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.JWT_SECRET;

const config = new ConfigManager();

const bot = new TelegramBot(token, {polling: true});

const sendResponseAndDelete = async (telegram_bot: TelegramBot, chatId: number, messageId: number, text: string, timeout = 5000) => {
    const response = await telegram_bot.sendMessage(chatId, text);
    setTimeout(() => {
        try {
            telegram_bot.deleteMessage(chatId, messageId);
            telegram_bot.deleteMessage(chatId, response.message_id);
        } catch {}
    }, timeout);
};

const handleYouTubeDownload = async (bot: TelegramBot, downloadUrl: string, chatId: number, messageId: number) => {
    const { DATA_DIRECTORY, CHMOD } = process.env;

    // yt-dlp --merge-output-format mkv --write-info-json --embed-thumbnail --add-metadata <url>
    const ytDlpCommand = `yt-dlp --merge-output-format mkv --write-info-json --embed-thumbnail --add-metadata ${downloadUrl}`;
    console.log(`Executing command: ${ytDlpCommand}`);

    // execute command in DATA_DIRECTORY
    const child_process = exec(ytDlpCommand, { cwd: DATA_DIRECTORY });

    child_process.stdout.on('data', (data) => {
        console.log(data);
    });

    child_process.stderr.on('data', (data) => {
        console.error(data);
    });

    child_process.on('close', async (code) => {
        console.log(`Process exited with code ${code}`);
        if (code === 0) {
            await sendResponseAndDelete(bot, chatId, messageId, 'Download completed!');

            // change file permissions
            const chmodCommand = `chmod -R ${CHMOD} ${DATA_DIRECTORY}`;
            console.log(`Executing command: ${chmodCommand}`);
            await exec(chmodCommand);
        } else {
            await sendResponseAndDelete(bot, chatId, messageId, 'Download failed!');
        }
    });

    child_process.on('error', async (err) => {
        console.error(err);
        await sendResponseAndDelete(bot, chatId, messageId, 'Download failed!');
    });

    await sendResponseAndDelete(bot, chatId, messageId, `Download of ${downloadUrl} started!`);
};

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const chatType = msg.chat.type;
    const chatTitle = msg.chat.title;
    const chatUsername = msg.chat.username;
    const firstName = msg.from.first_name;
    const lastName = msg.from.last_name;
    const username = msg.from.username;

    const user = {
        userId,
        chatId,
        chatType,
        chatTitle,
        chatUsername,
        firstName,
        lastName,
        username,
        auth: false,
    };

    if (config.check('' + userId)) {
        await sendResponseAndDelete(bot, chatId, msg.message_id, `Hello ${firstName ?? ''} ${lastName ?? ''}! You are already registered!`);
        return;
    }

    config.set('' + userId, user);

    user.auth = true;

    const code = jwt.sign(user, secret);
    console.log(`User ${userId} (${user.firstName} ${user.lastName}) has been registered with code ${code}`);

    await bot.sendMessage(chatId, `Hello ${firstName ?? ''} ${lastName ?? ''}! Please send me the code to authenticate you.`);
});

// '/token <code>'
bot.onText(/\/token (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    const token = match[1];

    const user = config.get('' + userId);

    if (!user) {
        await sendResponseAndDelete(bot, chatId, msg.message_id, 'You are not registered!');
        return;
    }

    if (user.auth) {
        await sendResponseAndDelete(bot, chatId, msg.message_id, 'You are already authenticated!');
        return;
    }

    try {
        const decoded = jwt.verify(token, secret) as any;
        if (decoded.userId === userId) {
            user.auth = true;
            await sendResponseAndDelete(bot, chatId, msg.message_id, 'You are authenticated!');

            config.set('' + userId, user);
        } else {
            await sendResponseAndDelete(bot, chatId, msg.message_id, 'You are not authenticated!');
        }
    } catch (e) {
        await sendResponseAndDelete(bot, chatId, msg.message_id, 'You are not authenticated!');
    }
});

// check if message begins with a youtube link
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // if message matches a command, ignore
    if (msg.text?.startsWith('/')) {
        return;
    }

    const user = config.get('' + userId);

    if (!user) {
        await sendResponseAndDelete(bot, chatId, msg.message_id, 'You are not registered!');
        return;
    }

    if (!user.auth) {
        await sendResponseAndDelete(bot, chatId, msg.message_id, 'You are not authenticated!');
        return;
    }

    const text = msg.text;
    if (!text) {
        return;
    }

    const ytDlpRegex = ytDlpRegexList.find((regex) => regex.test(text));
    if (!ytDlpRegex) {
        await sendResponseAndDelete(bot, chatId, msg.message_id, 'Please send me a youtube link!');
        return;
    }

    // log the link
    const link = ytDlpRegex.exec(text)[0];
    console.log(`User ${userId} (${user.firstName} ${user.lastName}) has requested ${link}`);

    await handleYouTubeDownload(bot, link, chatId, msg.message_id);
});
