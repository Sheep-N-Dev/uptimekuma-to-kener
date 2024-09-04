import dotenv from 'dotenv';
import dotenvExpand from 'dotenv-expand';

dotenvExpand.expand(dotenv.config());

import chalk from 'chalk';
import axios from 'axios';
import Logger from '@ptkdev/logger';

import { io } from 'socket.io-client';
import { CronJob } from 'cron';

import { getObjects, debug } from './libraries/utils.js';

import log_text from './logs_text.json' with { type: 'json' };

const logger = new Logger();

let monitorsList = {}
let lastHeartbeat = {}

const kener = axios.create({
    baseURL: process.env.KENER_URL,
    timeout: 1000,
    headers: {
        'Authorization': `Bearer ${process.env.KENER_TOKEN}`,
        'Content-Type' : 'application/json'
    }
});

const updateStatus = async (heart, tag, maxPing) => {
    logger.info("Start monitor update", log_text.kener);

    const monitor_id = heart.monitorID || heart.monitor_id;
    let status = 'DOWN'
    try {
        const monitor = getObjects(monitorsList,'id', monitor_id).find(item => item.type === 'push' || item.type === 'http' || item.type === 'port' || item.type === 'group' || item.type === 'docker' || item.type === 'json-query');

        if ( monitor.active !== true ) return;
        if ( monitor.type === 'group' ) {
            let childs_status = {}
            for await (const child_id of monitor.childrenIDs) {
                const child = getObjects(monitorsList,'id', child_id).find(item => item.type === 'push' || item.type === 'http' || item.type === 'port' || item.type === 'docker' || item.type === 'json-query');

                if (child !== null && child !== undefined) {
                    const child_heart = lastHeartbeat[child_id]
                    if (child_heart !== null && child_heart !== undefined) {
                        childs_status[child_id] = ((child_heart.status === 1) ? true : false);
                    }
                }
            }
            const total_child = Object.keys(childs_status).length;
            const total_child_online = Object.values(childs_status).filter(child => child === true).length;
            const total_child_offline = Object.values(childs_status).filter(child => child === false).length;
            const child_online_percentage = total_child_online / total_child;

            if ( total_child === total_child_offline ) {
                status = 'DOWN';
            } else if ( total_child === total_child_online ) {
                status = 'UP';
            } else if (total_child_offline >= 1 && child_online_percentage > 0.75) {
                console.log("Plus dsdqfsdqd.");
            } else if (child_online_percentage > 0.75) {
                console.log("Plus de 75% des valeurs sont true.");
            } else {
                status = 'DEGRADED';
            }
        } else {
            status = ((heart.status === 1) ? ((heart.ping  > parseInt(maxPing)) ? 'DEGRADED' : 'UP') : 'DOWN');
        }
    } catch (error) {
        logger.error(error, log_text.kener);
    }
    await kener.post('/api/status', {
        "status": status,
        "latency": heart.ping || 0,
        //"timestampInSeconds": Math.round(Date.now() / 1000),
        "tag": tag
    }).then(function (response) {
        const monitor = getObjects(monitorsList,'id', monitor_id).find(item => item.type === 'push' || item.type === 'http' || item.type === 'port' || item.type === 'group' || item.type === 'docker' || item.type === 'json-query');

        logger.info(`${monitor.name} Updated status (maxPing: ${maxPing})`, log_text.kener);
    }).catch(function (error) {
        logger.error(error, log_text.kener)
    });
}

const socket = io(process.env.KUMA_URL);

socket.on("connect", () => {
    logger.info(`Connected to ${chalk.gray(process.env.KUMA_URL)}`, log_text.kuma);
    socket.emit("login", { username: process.env.KUMA_USER,  password: process.env.KUMA_PASS,  token: null }, (res) => {
        if (res.tokenRequired) {
            logger.error("Error 2FA enabled on this account", log_text.kuma);
            return socket.disconnect();
        }

        if (res.ok) {
            socket.uptime_kuma_token = res.token;
            logger.info("Logged In", log_text.kuma);
        } else {
            logger.error("An error has occurred", log_text.kuma);
            console.log(res, 'error');
            return socket.disconnect();
        }
    });
});

socket.on("connect_error", (err) => {
    logger.error(`Failed to connect to the backend. Socket.io connect_error: ${err.message}`, log_text.kuma);
});

socket.on("disconnect", () => {
    logger.error(`Disconnected from the socket server`, log_text.kuma);
});

socket.on("monitorList", async (monitors) => {
    logger.info(`Received ${chalk.gray(Object.keys(monitors).length)} Monitors`, log_text.kuma);
    monitorsList = monitors;
});

socket.on("heartbeatList", async (monitor_id, data, overwrite = false) => {
    try {
        const monitor = getObjects(monitorsList,'id', monitor_id).find(item => item.type === 'push' || item.type === 'http' || item.type === 'port' || item.type === 'group' || item.type === 'docker' || item.type === 'json-query');
        if (!monitor) return console.log(monitor_id);
        console.log()
        const heart = data[data.length-1];
        if (data.length === 0) return logger.info(`Received heartbeat for ${chalk.gray(monitor.id.toString().padStart(2, '0'))}|${chalk.magenta(monitor.name)} with ${chalk.bgCyan.black(' No data ')}`, log_text.hb);
        logger.info(`Received heartbeat for ${chalk.gray(monitor.id.toString().padStart(2, '0'))}|${chalk.magenta(monitor.name)} is ${((heart.status === 1) ? chalk.greenBright(log_text.up) : chalk.redBright(log_text.down))}${((lastHeartbeat[monitor_id]) ? " " + ((lastHeartbeat[monitor_id].status === 1) ? chalk.grey(log_text.up) : chalk.grey(log_text.down)) : '')}`, log_text.hb);
        lastHeartbeat[monitor_id] = heart;
        if (lastHeartbeat[monitor_id]) {
            lastHeartbeat[monitor_id]['timestamp'] = Date.now();
        }

        const tag = monitor.tags.find(item => item.name === 'kener');
        const maxPing = monitor.tags.find(item => item.name === 'max_ping');

        if ((tag !== null && tag !== undefined) || (maxPing !== null && maxPing !== undefined)) logger.info(`${chalk.magentaBright('Tags')}${chalk.grey(':')}`, log_text.hb);
        if (tag !== null && tag !== undefined)         logger.info(chalk.blue(`     Kener${chalk.grey(':')} ${chalk.yellow(tag.value)}`), log_text.hb);
        if (maxPing !== null && maxPing !== undefined) logger.info(chalk.blue(`     Max Ping${chalk.grey(':')} ${chalk.yellow(maxPing.value)}`), log_text.hb);

        if (tag !== null && tag !== undefined) {
            await updateStatus(heart, tag.value, ((maxPing !== null && maxPing !== undefined) ? maxPing.value : 2000));
        }
    } catch (error) {
        console.log(error)
    }
});

socket.on("heartbeat", (data) => {
    try {
        const monitor = getObjects(monitorsList,'id', data.monitorID).find(item => item.type === 'push' || item.type === 'http' || item.type === 'port' || item.type === 'group' || item.type === 'docker' || item.type === 'json-query');

        lastHeartbeat[data.monitorID] = data;
        lastHeartbeat[data.monitorID]['timestamp'] = Date.now();
        if (!monitor) return false;
        logger.info(`Receive for monitor #${data.monitorID} (${monitor.name})`, "Heartbeat");

        const tag = monitor.tags.find(item => item.name === 'kener');
        const maxPing = monitor.tags.find(item => item.name === 'max_ping');
        if (tag !== null && tag !== undefined) {
            updateStatus(data, tag.value, ((maxPing !== null && maxPing !== undefined) ? maxPing.value : 2000));
        }
    } catch (error) {
        console.log(error)
    }
});
socket.on("uptime", (monitorID, dd, gg) => {
    if (lastHeartbeat[monitorID] === undefined || lastHeartbeat[monitorID] === null) return;
    lastHeartbeat[monitorID]['timestamp'] = Date.now();
    try {
        const monitor = getObjects(monitorsList,'id', monitorID).find(item => item.type === 'push' || item.type === 'http' || item.type === 'port' || item.type === 'group' || item.type === 'docker' || item.type === 'json-query');
        if (!monitor) return false;
        logger.info(`Receive for monitor #${monitorID} (${monitor.name})`, "Uptime");

        const lh = lastHeartbeat[monitorID]
        if (lh) {
            const cur = Date.now();
            const tag = monitor.tags.find(item => item.name === 'kener')
            const maxPing = monitor.tags.find(item => item.name === 'max_ping');
            if ((cur - lh.timestamp) >= 30 && tag !== undefined) {
                updateStatus(lh, tag.value, ((maxPing !== null && maxPing !== undefined) ? maxPing.value : 2000));
                lastHeartbeat[monitorID]['timestamp'] = Date.now();
            }
        }
    } catch (error) {
        console.log(error)
    }
});

const job = CronJob.from({
	cronTime: '5 */1 * * * *',
	onTick: function () {
        logger.info(`Cron as triggered`, "Cron");
        for (const mon in lastHeartbeat) {
            const heartbeat = lastHeartbeat[mon];

            const monitor = getObjects(monitorsList,'id', heartbeat.monitorID).find(item => item.type === 'push' || item.type === 'http' || item.type === 'port' || item.type === 'group' || item.type === 'docker' || item.type === 'json-query');
            if (monitor !== null && monitor !== undefined) {
                const tag = monitor.tags.find(item => item.name === 'kener')
                const maxPing = monitor.tags.find(item => item.name === 'max_ping');
                if (tag !== null && tag !== undefined) {
                    updateStatus(heartbeat, tag.value, ((maxPing !== null && maxPing !== undefined) ? maxPing.value : 2000));
                }
            }
        }
	},
	start: false,
	timeZone: 'Europe/Paris'
});