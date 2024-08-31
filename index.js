import dotenv from 'dotenv';
import dotenvExpand from 'dotenv-expand';

dotenvExpand.expand(dotenv.config());

import axios from 'axios';
import Logger from '@ptkdev/logger';

import { io } from 'socket.io-client';
import { CronJob } from 'cron';

import { getObjects, debug } from './libraries/utils.js';

import log_text from './logs_text.json' with { type: 'json' };

const logger = new Logger();

const kener = axios.create({
    baseURL: process.env.KENER_URL,
    timeout: 1000,
    headers: {
        'Authorization': `Bearer ${process.env.KENER_TOKEN}`,
        'Content-Type' : 'application/json'
    }
});

function updateStatus (heart, tag, maxPing) {
    logger.info("Start monitor update", log_text.kener);
    kener.post('/api/status', {
        "status": ((heart.status === 1) ? ((heart.ping  > parseInt(maxPing)) ? 'DEGRADED' : 'UP') : 'DOWN'),
        "latency": heart.ping || 0,
        //"timestampInSeconds": Math.round(Date.now() / 1000),
        "tag": tag
    }).then(function (response) {
        const monitor = getObjects(monitorsList,'id', heart.monitor_id || heart.monitorID).find(item => item.type === 'push' || item.type === 'http' || item.type === 'port' || item.type === 'group' || item.type === 'docker');

        logger.info(`${monitor.name} Updated status (maxPing: ${maxPing})`, log_text.kener);
    }).catch(function (error) {
        logger.error(error, log_text.kener)
        console.log(error)
    });
}

let monitorsList = {}
let lastHeartbeat = {}

const socket = io(process.env.KUMA_URL);

socket.on("connect", () => {
    logger.info("Connected to socket", log_text.kuma);
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
    logger.error(`disconnected from the socket server`, log_text.kuma);
});

socket.on("monitorList", async (monitors) => {
    logger.info(`Receive ${Object.keys(monitors).length} Monitors`, log_text.kuma);
    monitorsList = monitors;
});

socket.on("heartbeatList", (monitor_id, data, overwrite = false) => {
    try {
        const monitor = getObjects(monitorsList,'id', monitor_id).find(item => item.type === 'push' || item.type === 'http' || item.type === 'port' || item.type === 'group' || item.type === 'docker');

        logger.info(`Receive list for monitor #${monitor_id} (${log_text[monitor.type]} | ${monitor.name})`, "Heartbeat List");

        const tag = monitor.tags.find(item => item.name === 'kener');
        const maxPing = monitor.tags.find(item => item.name === 'max_ping');
        if (tag !== null && tag !== undefined) {
            const heart = data[data.length-1];
            lastHeartbeat[monitor_id] = heart;
            lastHeartbeat[monitor_id]['timestamp'] = Date.now();

            updateStatus(heart, tag.value, ((maxPing !== null && maxPing !== undefined) ? maxPing.value : 2000));
        }
    } catch (error) {
        console.log(error)
    }
});

socket.on("heartbeat", (data) => {
    try {
        const monitor = getObjects(monitorsList,'id', data.monitorID).find(item => item.type === 'push' || item.type === 'http' || item.type === 'port' || item.type === 'group' || item.type === 'docker');

        logger.info(`Receive for monitor #${data.monitorID} (${monitor.name})`, "Heartbeat");

        const tag = monitor.tags.find(item => item.name === 'kener');
        lastHeartbeat[data.monitorID] = data;
        lastHeartbeat[data.monitorID]['timestamp'] = Date.now();
        const maxPing = monitor.tags.find(item => item.name === 'max_ping');
        if (tag !== null && tag !== undefined) {
            updateStatus(data, tag.value, ((maxPing !== null && maxPing !== undefined) ? maxPing.value : 2000));
        }
    } catch (error) {
        console.log(error)
    }
});

socket.on("uptime", (monitorID, dd, gg) => {
    try {
        const monitor = getObjects(monitorsList,'id', monitorID).find(item => item.type === 'push' || item.type === 'http' || item.type === 'port' || item.type === 'group' || item.type === 'docker');

        logger.info(`Receive for monitor #${monitorID} (${monitor.name})`, "Uptime");

        const lh = lastHeartbeat[monitorID]
        if (lh) {
            const cur = Date.now();
            const tag = monitor.tags.find(item => item.name === 'kener')
            const maxPing = monitor.tags.find(item => item.name === 'max_ping');
            if ((cur - lh.timestamp) >= 30 && tag !== undefined) {
                console.log((cur - lh.timestamp))
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

            const monitor = getObjects(monitorsList,'id', heartbeat.monitorID).find(item => item.type === 'push' || item.type === 'http' || item.type === 'port' || item.type === 'group' || item.type === 'docker');
            if (monitor !== null && monitor !== undefined) {
                const tag = monitor.tags.find(item => item.name === 'kener')
                const maxPing = monitor.tags.find(item => item.name === 'max_ping');
                if (tag !== null && tag !== undefined) {
                    updateStatus(heartbeat, tag.value, ((maxPing !== null && maxPing !== undefined) ? maxPing.value : 2000));
                }
            }
        }
	},
	start: true,
	timeZone: 'Europe/Paris'
});