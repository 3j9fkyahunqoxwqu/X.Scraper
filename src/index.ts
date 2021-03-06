require('dotenv').config({ path: '.env' });

import * as express from 'express'
import * as bodyParser from 'body-parser'
import * as methodOverride from 'method-override'
import * as moment from 'moment'

import logger from "./logger"
import influx from "./influxClient"
import Scheduler from "./Scheduler"
import ProxyChecker from "./ProxyChecker"
import UncheckedProxyGrabber from "./UncheckedProxyGrabber"
import ProxyCleaner from "./ProxyCleaner"
import expressInfluxMetrics from "./expressMetricsInflux"
import expressUserAgent from "./expressUserAgent"

import { RegisterRoutes } from './routes/routes'
import { sequelize } from "./Sequelize"
import { MeterApi } from "./xmeterapi/api"

import './controllers/relevantController'
import './controllers/proxyController'

const { XMETER_USERNAME, XMETER_PASSWORD, XMETER_HOST, PORT, GRAB_TIMEOUT, CHECK_TIMEOUT } = process.env;
const app = express();

app.set('trust proxy', true);
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(methodOverride());
app.use(expressUserAgent());
app.use(expressInfluxMetrics({
    batchSize: 10,
    logger: logger,
    influxClient: influx
}));

RegisterRoutes(app);

const errorHandler = (err: any, req: express.Request, res: express.Response, next: Function) => {
    const { status } = err;
    res.status(status).json(err);
};

app.use(errorHandler);

app.listen(parseInt(PORT || '8080')).on('listening', async () => {
    try {
        await sequelize.sync();
    } catch (e) {
        logger.error(`DB failed to connect. Reason: ${e}`);
        process.exit(1);
    }

    const proxyChecker = new ProxyChecker(new MeterApi(XMETER_USERNAME, XMETER_PASSWORD, XMETER_HOST));
    const uncheckedProxyGrabber = UncheckedProxyGrabber.create();

    try {
        await uncheckedProxyGrabber.populate();
        await ProxyCleaner.run();
        await proxyChecker.checkProxies();
        await proxyChecker.checkDeadProxies();
    } catch (e) {
        logger.error(e.message);
    }

    logger.debug('Setting schedules');

    Scheduler.schedule(uncheckedProxyGrabber.populate.bind(uncheckedProxyGrabber), moment.duration(GRAB_TIMEOUT).asMilliseconds());
    Scheduler.schedule(proxyChecker.checkProxies.bind(proxyChecker), moment.duration(CHECK_TIMEOUT).asMilliseconds());
    Scheduler.schedule(proxyChecker.checkDeadProxies.bind(proxyChecker), moment.duration(CHECK_TIMEOUT).asMilliseconds() * 3);
    Scheduler.schedule(ProxyCleaner.run, moment.duration(CHECK_TIMEOUT).asMilliseconds() * 2);
});
