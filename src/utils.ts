import * as TelegramBot from 'node-telegram-bot-api';
import {exec} from 'child_process';
import YTDlpWrap from 'yt-dlp-wrap';
import * as fs from 'fs';
import * as nodepath from 'path';

const ytDlp = new YTDlpWrap();

const tempDir = '/tmp/ytdlp-telegram-bot';

export async function asyncExec(command: string, options: any = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
        exec(command, options, (error, stdout, stderr) => {
            if (error) {
                reject(error);
            } else {
                resolve(stdout);
            }
        });
    });
}

export async function createDirIfNotExists(dir: string): Promise<void> {
    if (!fs.existsSync(dir)) {
        await asyncExec(`mkdir -p ${dir}`);
    }
}

export const sendResponseAndDelete = async (telegram_bot: TelegramBot, chatId: number, messageId: number, text: string, timeout = 5000) => {
    const response = await telegram_bot.sendMessage(chatId, text);
    setTimeout(() => {
        try {
            telegram_bot.deleteMessage(chatId, messageId);
            telegram_bot.deleteMessage(chatId, response.message_id);
        } catch { /* empty */ }
    }, timeout);
};

export const handleYouTubeDownload = async (bot: TelegramBot, downloadUrl: string, chatId: number, messageId: number) => {
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

export interface FileListing {
    name: string;
    id: string;
}

export const getXNewestFiles = async (directory: string, count: number) : Promise<FileListing[]> => {
    return new Promise((resolve, reject) => {
        // list count newest mkv files
        const command = `ls -t ${directory}/*.mkv | head -n ${count}`;

        console.log(`Executing command: ${command}`);

        exec(command, (err, stdout, stderr) => {
            if (err) {
                reject(err);
            }

            const files = stdout.split('\n').filter((f) => f !== '').map((f) => {
                const fileName = f.split('/').pop();
                const youtubeId = fileName?.match(/\[(.*?)\]/)?.[1];
                const videoName = fileName.slice(0, fileName.indexOf(youtubeId) - 2);
                return {
                    name: videoName,
                    id: youtubeId,
                };
            });
            resolve(files);
        });
    });
};

export interface VideoFile {
    name: string;
    path: string;
    id: string;
    json: any;
}

export const getVideoFile = async (directory: string, id: string) : Promise<VideoFile> => {
    const command = `ls ${directory}/*${id}*.mkv`;
    console.log(`Executing command: ${command}`);

    return new Promise((resolve, reject) => {
        exec(command, (err, stdout, stderr) => {
            if (err) {
                reject(err);
            }

            const fileName = stdout.split('\n').filter((f) => f !== '').pop();
            const videoName = fileName?.slice(0, fileName.indexOf(id) - 2);
            const jsonFile = fileName?.replace('.mkv', '.info.json');

            const json = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));

            resolve({
                name: videoName,
                path: fileName,
                id,
                json,
            });
        });
    });
};

export const escapePath = (path: string) : string => {
    //  /data/jellyfin-data/YouTube/Fixed [4s_f0FGeH14].mkv -> "/data/jellyfin-data/YouTube/Fixed\ \[4s_f0FGeH14\].mkv"
    return nodepath.normalize(path).replace(/ /g, '\\ ');
};

export interface TranscodedVideo {
    path: string;
    afterUse: () => Promise<void>;
}

export const transcodeVideo = async (video: VideoFile, onProgress: (status: number) => void) : Promise<TranscodedVideo> => {
    // mkv -> mp4. when sending mp4 is finished, delete mkv using afterUse
    // do everything in /tmp directory with mktemp
    const path = escapePath(video.path);

    const outFile = `${tempDir}/video-${video.id}.mp4`;

    // check if outfile already exists
    if (fs.existsSync(outFile)) {
        console.log(`File ${outFile} already exists, skipping transcoding!`);
        return {
            path: outFile,
            afterUse: async () => {
                // delete mkv
                await asyncExec(`rm ${path}`);
            },
        };
    }

    // get frame count
    const ffprobeCommand = `ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of default=nokey=1:noprint_wrappers=1 ${path}`;
    console.log(`Executing command: ${ffprobeCommand}`);

    const duration = parseInt(await asyncExec(ffprobeCommand) as string);

    const command = `ffmpeg -i ${path} -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 128k -movflags +faststart -progress - -y ${outFile}`;
    console.log(`Executing command: ${command}`);

    // create tmp if not exists
    await createDirIfNotExists(tempDir);

    return new Promise((resolve, reject) => {
        const ffmpeg = exec(command, (err, stdout, stderr) => {
            if (err) {
                reject(err);
            }

            console.log(`Transcoding of ${path} finished!`);
            resolve({
                path: outFile,
                afterUse: async () => {
                    // delete temp
                    const deleteTempCommand = `rm -rf ${tempDir}`;
                    console.log(`Executing command: ${deleteTempCommand}`);
                    await exec(deleteTempCommand);
                },
            });
        });

        ffmpeg.stdout.on('data', (data) => {
            // console.log('stdout', data);

            // parse as key/value
            const progressData = {};
            data.split('\n').filter((l) => l !== '').map((l) => {
                const [key, value] = l.split('=');
                progressData[key] = value;
            });

            // calculate progress
            const currentFrame = parseInt(progressData['frame'], 10);
            const progress = Math.round((currentFrame / duration) * 100);
            // console.log(`Progress: ${progress}% (${currentFrame}/${duration})`);
            onProgress(progress);
        });

        ffmpeg.stderr.on('data', (data) => {
            console.error('stderr', data);
        });

        ffmpeg.on('close', (code) => {
            console.log(`Process exited with code ${code}`);
        });

        ffmpeg.on('error', (err) => {
            console.error('error', err);
        });
    });
};
