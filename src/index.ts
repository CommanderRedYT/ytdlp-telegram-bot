import * as dotenv from 'dotenv';
import * as TelegramBot from 'node-telegram-bot-api';
import ConfigManager from './config';
import * as jwt from 'jsonwebtoken';
import { exec } from 'child_process';
import YTDlpWrap from 'yt-dlp-wrap';

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

const config = new ConfigManager();

const ytDlp = new YTDlpWrap();

const bot = new TelegramBot(token, { polling: true });

const sendResponseAndDelete = async (telegram_bot: TelegramBot, chatId: number, messageId: number, text: string, timeout = 5000) => {
    const response = await telegram_bot.sendMessage(chatId, text);
    setTimeout(() => {
        try {
            telegram_bot.deleteMessage(chatId, messageId);
            telegram_bot.deleteMessage(chatId, response.message_id);
        } catch { /* empty */ }
    }, timeout);
};

const handleYouTubeDownload = async (bot: TelegramBot, downloadUrl: string, chatId: number, messageId: number) => {
    const { DATA_DIRECTORY, CHMOD } = process.env;

    const statusMessage = await bot.sendMessage(chatId, `Processing ${downloadUrl}...`);
    let currentMessageContent = '';
    let lastStatusMessageUpdate = Date.now();

    const ytDlpResult = ytDlp.exec([
        '--merge-output-format',
        'mkv',
        '--write-info-json',
        '--add-metadata',
        '--write-thumbnail',
        '-o',
        'thumbnail:%(title)s [%(id)s]-poster.%(ext)s',
        downloadUrl,
    ], {
        cwd: DATA_DIRECTORY,
    });

    ytDlpResult.on('progress', (progress) => {
        // send progress to user
        if (Date.now() - lastStatusMessageUpdate < 300) {
            return;
        }

        const newMessage = `Download of ${downloadUrl} started! ${progress.percent}%`;

        if (newMessage === currentMessageContent) {
            return;
        }

        currentMessageContent = newMessage;

        console.log(`Updating message: Progress: ${progress.percent}% (${downloadUrl})`);

        bot.editMessageText(currentMessageContent, {
            chat_id: chatId,
            message_id: statusMessage.message_id,
        });

        lastStatusMessageUpdate = Date.now();
    });

    ytDlpResult.on('error', async (err) => {
        console.error(err);
        await sendResponseAndDelete(bot, chatId, messageId, 'Download failed!');

        // delete status message
        setTimeout(() => {
            try {
                bot.deleteMessage(chatId, statusMessage.message_id);
            } catch { /* empty */ }
        }, 5000);
    });

    ytDlpResult.on('close', async (code) => {
        console.log(`Process exited with code ${code}`);
        if (code === 0) {
            await sendResponseAndDelete(bot, chatId, messageId, `Download of ${downloadUrl} finished!`);

            // convert poster from webp to jpg
            const convertPosterCommand = `for f in ${DATA_DIRECTORY}/*.webp; do convert "$f" "$\{f%.webp}.jpg"; done`;
            console.log(`Executing command: ${convertPosterCommand}`);
            await exec(convertPosterCommand);

            // change file permissions
            const chmodCommand = `chmod -R ${CHMOD} ${DATA_DIRECTORY}`;
            console.log(`Executing command: ${chmodCommand}`);
            await exec(chmodCommand);

            console.log(`Saving of ${downloadUrl} finished!`);
        } else {
            await sendResponseAndDelete(bot, chatId, messageId, `Download of ${downloadUrl} failed! (code: ${code})`);
        }

        // delete status message
        setTimeout(() => {
            try {
                bot.deleteMessage(chatId, statusMessage.message_id);
            } catch { /* empty */
            }
        }, 5000);
    });
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

console.log('Bot is online!');
