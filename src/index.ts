import * as dotenv from 'dotenv';
import * as TelegramBot from 'node-telegram-bot-api';
import ConfigManager from './config';
import * as jwt from 'jsonwebtoken';
import { handleYouTubeDownload, sendResponseAndDelete, getXNewestFiles, getVideoFile, transcodeVideo } from './utils';
import * as fs from 'fs';

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
    // youtu.be
    /https?:\/\/youtu\.be\/([a-zA-Z0-9_-]{11})/,
    // youtube shorts
    /https?:\/\/(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
];

const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.JWT_SECRET;
const { DATA_DIRECTORY } = process.env;

const config = new ConfigManager();

const bot = new TelegramBot(token, { polling: true });

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

// '/list <number>'
// list the last <number> of downloads
bot.onText(/\/list (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    const user = config.get('' + userId);

    if (!user) {
        await sendResponseAndDelete(bot, chatId, msg.message_id, 'You are not registered!');
        return;
    }

    if (!user.auth) {
        await sendResponseAndDelete(bot, chatId, msg.message_id, 'You are not authenticated!');
        return;
    }

    const number = parseInt(match[1]);
    if (isNaN(number)) {
        await sendResponseAndDelete(bot, chatId, msg.message_id, 'Invalid number!');
        return;
    }

    const downloads = await getXNewestFiles(DATA_DIRECTORY, number);

    const message = downloads.map(({ name, id }, index) => {
        return `${index + 1}. *"${name}"* - \`${id}\``;
    }).join('\r\n');

    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

// '/send <id> <true|false>' where the second parameter is optional
bot.onText(/\/send (.+) ?(.+)?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    const user = config.get('' + userId);

    if (!user) {
        await sendResponseAndDelete(bot, chatId, msg.message_id, 'You are not registered!');
        return;
    }

    if (!user.auth) {
        await sendResponseAndDelete(bot, chatId, msg.message_id, 'You are not authenticated!');
        return;
    }

    const id = match[1];
    const deleteAfterSend = match[2] !== 'false';

    const file = await getVideoFile(DATA_DIRECTORY, id);

    if (!file) {
        await sendResponseAndDelete(bot, chatId, msg.message_id, 'Invalid id!');
        return;
    }

    const {
        channel,
        title,
    } = file.json; // yt-dlp json

    console.log(`Sending file ${file.name} with id ${file.id} to user ${userId} (${user.firstName} ${user.lastName})`, file.path);

    const statusMessage = await bot.sendMessage(chatId, `Transcoding ${title}...\nPlease wait...`);
    console.log(statusMessage.message_id);

    let progress = 0;

    const {
        path,
        afterUse
    } = await transcodeVideo(file, (new_progress) => {
        console.log(new_progress);
        if (new_progress === progress) {
            return;
        }

        progress = new_progress;

        bot.editMessageText(`Transcoding ${title} (${file.id})...\nPlease wait... ${progress}%`, {
            chat_id: chatId,
            message_id: statusMessage.message_id,
        });
    });

    await bot.editMessageText(`Sending ${title} (${file.id})...\nPlease wait...`, {
        chat_id: chatId,
        message_id: statusMessage.message_id,
    });

    try {
        await bot.sendVideo(chatId, path, {caption: `${channel} - ${title}`});
    } catch (e) {
        console.error(e);
    }

    if (deleteAfterSend) {
        await afterUse();
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

console.log('Bot is online!');
